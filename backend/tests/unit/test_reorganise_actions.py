"""
Unit tests for app/core/reorganise_actions.py: the strict checklist
schema, raw-output conversion, and the deterministic fallback checklist.
Pure logic, no model, no network.
"""

from __future__ import annotations

import re

import pytest
from pydantic import ValidationError

from app.core.reorganise_actions import (
    INSTRUCTION_MAX_LENGTH,
    INSTRUCTION_MIN_LENGTH,
    MAX_ACTIONS,
    MIN_ACTIONS,
    TITLE_MAX_LENGTH,
    TITLE_MIN_LENGTH,
    ReorganiseAction,
    ReorganiseActionList,
    build_deterministic_checklist,
    expected_action_range,
    find_forbidden_content,
    parse_and_validate_actions,
)
from app.core.schemas import BoundingBox, DetectedItem


def _item(item_id: str, label: str, position: str = "upper-left", size: str = "small", corrected=None) -> DetectedItem:
    index = int(item_id.split("_")[1])
    return DetectedItem(
        item_id=item_id,
        source_detection_index=index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.2, y2=0.2),
        confidence=0.5,
        position=position,
        relative_size=size,
        corrected_label=corrected,
    )


def _action(priority=1, title="Clear the desk", instruction="Group the keyboard and mouse together on the desk."):
    return {"priority": priority, "title": title, "instruction": instruction}


def _raw(*actions):
    return {"actions": list(actions)}


# --- schema -------------------------------------------------------------------


def test_valid_checklist_is_accepted_and_normalised_to_priority_order():
    result = parse_and_validate_actions(_raw(_action(2, "Second", "Do the second thing carefully."), _action(1)))
    assert result.is_valid
    assert [a.priority for a in result.actions] == [1, 2]
    assert result.actions[1].title == "Second"


@pytest.mark.parametrize(
    "raw",
    [
        None,
        [],
        "actions",
        {},
        {"actions": []},
        {"actions": [_action()], "zones": []},
        {"actions": [_action(), _action(1)]},  # repeated priority
        {"actions": [_action(1), _action(3)]},  # gap
        {"actions": [_action(0)]},
        {"actions": [_action(6)]},
        {"actions": [_action("1")]},  # string priority is not coerced
        {"actions": [_action(1.0)]},
        {"actions": [_action(True)]},
        {"actions": [dict(_action(), item_ids=["item_001"])]},
        {"actions": [dict(_action(), coordinates=[0.1, 0.2])]},
        {"actions": [_action(title="ab")]},
        {"actions": [_action(title="x" * (TITLE_MAX_LENGTH + 1))]},
        {"actions": [_action(instruction="too short")]},
        {"actions": [_action(instruction="x" * (INSTRUCTION_MAX_LENGTH + 1))]},
        {"actions": [_action(instruction="   ")]},
        {"actions": [_action(i + 1) for i in range(MAX_ACTIONS + 1)]},
    ],
)
def test_malformed_checklists_are_reported_never_raised(raw):
    result = parse_and_validate_actions(raw)
    assert not result.is_valid
    assert result.actions is None
    assert [e.kind for e in result.errors] == ["malformed_actions"]
    assert len(result.errors[0].detail) <= 300


def test_between_one_and_five_actions_are_accepted():
    assert parse_and_validate_actions(_raw(_action(1))).is_valid
    assert parse_and_validate_actions(_raw(*[_action(i + 1) for i in range(MAX_ACTIONS)])).is_valid


# --- selection-dependent floor ---------------------------------------------------


@pytest.mark.parametrize("count,expected", [(1, (1, 3)), (2, (1, 3)), (3, (3, 5)), (4, (3, 5)), (28, (3, 5))])
def test_expected_action_range_by_selection_size(count, expected):
    assert expected_action_range(count) == expected
    assert expected_action_range(count)[1] <= MAX_ACTIONS


@pytest.mark.parametrize("bad", [0, -1, True, 2.0, "3", None])
def test_expected_action_range_rejects_a_non_positive_or_non_integer_count(bad):
    with pytest.raises(ValueError):
        expected_action_range(bad)


@pytest.mark.parametrize("min_actions,count", [(3, 2), (3, 1), (2, 1)])
def test_a_valid_checklist_below_the_floor_is_too_few_actions_never_partially_accepted(min_actions, count):
    result = parse_and_validate_actions(_raw(*[_action(i + 1) for i in range(count)]), min_actions=min_actions)
    assert not result.is_valid
    assert result.actions is None
    assert [e.kind for e in result.errors] == ["too_few_actions"]
    assert f"has {count} action(s); at least {min_actions} expected" in result.errors[0].detail


@pytest.mark.parametrize("min_actions,count", [(3, 3), (3, 5), (1, 1), (1, 5)])
def test_a_checklist_at_or_above_the_floor_is_accepted(min_actions, count):
    assert parse_and_validate_actions(_raw(*[_action(i + 1) for i in range(count)]), min_actions=min_actions).is_valid


def test_the_floor_defaults_to_the_schema_minimum():
    assert parse_and_validate_actions(_raw(_action(1))).is_valid


def test_shape_errors_win_over_the_floor():
    # not even a checklist: reported as malformed, not as too few
    result = parse_and_validate_actions({"actions": []}, min_actions=3)
    assert [e.kind for e in result.errors] == ["malformed_actions"]


@pytest.mark.parametrize("bad", [0, 6, True, 2.5, "3"])
def test_an_out_of_range_floor_is_a_caller_error(bad):
    with pytest.raises(ValueError, match="min_actions"):
        parse_and_validate_actions(_raw(_action(1)), min_actions=bad)


def test_action_schema_is_strict_about_shape():
    with pytest.raises(ValidationError):
        ReorganiseAction(priority=1, title="Clear the desk", instruction="Group the keyboard and mouse.", extra="x")
    with pytest.raises(ValidationError):
        ReorganiseActionList(actions=[])


# --- forbidden content --------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Buy a new shelf for the books.",
        "Order online a cable organiser.",
        "Pick up some boxes from IKEA.",
        "See https://example.test/box for a tray.",
        "This costs $12 at most.",
        "Donate the old books.",
        "Sell the lamp you no longer use.",
        "Throw away the picture frame.",
        "Get rid of the toys.",
        "Dispose of the chair.",
    ],
)
def test_shopping_and_removal_language_is_rejected(text):
    result = parse_and_validate_actions(_raw(_action(1, "Step", text)))
    assert not result.is_valid
    assert [e.kind for e in result.errors] == ["forbidden_content"]
    assert find_forbidden_content(text) is not None


@pytest.mark.parametrize(
    "text",
    [
        "Group the books upright in order of size on the desk.",
        "Keep the chargers together beside the laptop.",
        "Fold the clothes and stack them on the shelf you already have.",
        "Straighten the picture frames along the wall.",
    ],
)
def test_ordinary_tidying_language_is_allowed(text):
    assert find_forbidden_content(text) is None
    assert parse_and_validate_actions(_raw(_action(1, "Step", text))).is_valid


def test_forbidden_content_in_a_title_is_caught_too():
    result = parse_and_validate_actions(_raw(_action(1, "Buy storage", "Put the books together neatly.")))
    assert [e.kind for e in result.errors] == ["forbidden_content"]


# --- deterministic fallback ---------------------------------------------------

INVENTED = re.compile(r"\b(drawer|bin|cupboard|basket|shelf|wardrobe|box|closet|cabinet|tray)\b", re.I)

# Narration the checklist must never carry again: counts, inventories and
# "of your photo" recaps duplicate the structured focus-area data and make
# the steps hard to scan.
NARRATION = re.compile(
    r"holds \d+ of your selected|of your photo|Next, the|You selected \d+|currently (?:on|in|across)|"
    r"instead of being scattered|are compatible|labelled '|Start with the",
    re.I,
)
POSITION_WORDS = re.compile(r"\b(?:left|right|centre|center|side|upper|lower|scattered|currently)\b", re.I)

# Placement advice the fallback must never give: arranging things around,
# on, beside or next to another item as a DESTINATION assumes a
# relationship, a surface or a container that nothing in the detection
# data supports. ("Tidy loose items around the shelf" names the shelf as
# the landmark of the space being tidied, never as somewhere to put
# things; what is banned is arranging one item relative to ANOTHER.)
PLACEMENT = re.compile(
    r"\b(arrange\w*|beside|next to|on top|onto|on the \w+ (?:shelf|desk|table)|into the|inside|neatly around|put \w+ (?:on|in|around))\b",
    re.I,
)

# The only title shapes the fallback may produce: each a complete,
# self-contained imperative. Anything else (a count, a parenthesised
# inventory, a bare area name) is a regression.
TITLE_SHAPES = re.compile(
    r"^(?:Group the .+ items|Group (?:technology accessories|toys and games|books and papers|clothing, bags and shoes|"
    r"jewellery, keys, watches and glasses)|Tidy loose items (?:on the (?:left|right) side|in the centre|in other areas)|"
    r"Tidy the (?:left side|right side|centre|other areas) without moving the .+|Clear the space around the .+|"
    r"Straighten the .+|Do a final space check)$"
)
CLEANUP_TITLE = re.compile(r"^(?:Tidy loose items|Tidy the \w+(?: side)? without moving|Clear the space around|Straighten the)\b")
FINAL_CHECK_TITLE = "Do a final space check"

# Proximity the data cannot prove: coarse-area membership never shows a
# smaller item is physically around, on or beside a large one, so an
# anchor instruction may only say the anchor stays and the rest is "in
# the area". ("clear the immediate space around it" is about the space
# next to the one named item, never about where other items are.)
UNSUPPORTED_PROXIMITY = re.compile(
    r"\b(?:items?|them|these) (?:around|on top of|beside|next to|near|onto) the\b|\baround the \w+ (?:and|,)", re.I
)


def _one_sentence(text: str) -> bool:
    return text.endswith(".") and ". " not in text and "! " not in text and "? " not in text


def _room():
    return [
        _item("item_001", "lamp", "upper-left"),
        _item("item_002", "book", "upper-left"),
        _item("item_003", "book", "center"),
        _item("item_004", "charger", "lower-right"),
        _item("item_005", "cable", "right"),
        _item("item_006", "desk", "upper-left", "large"),
        _item("item_007", "picture frame", "upper-right"),
    ]


def _fixture_28():
    import json
    from pathlib import Path

    fixture = Path(__file__).resolve().parents[2] / "evaluation" / "fixtures" / "reorganise_bedroom02_28items.json"
    raw = json.loads(fixture.read_text(encoding="utf-8"))
    return [DetectedItem.model_validate(entry) for entry in raw["items"]], raw["scene_label"]


def test_fallback_is_deterministic():
    assert build_deterministic_checklist(_room(), "bedroom") == build_deterministic_checklist(_room(), "bedroom")


# -- priority order: meaningful groups first, one cleanup, then the check --


def test_fallback_puts_repeated_label_and_compatible_groups_before_area_cleanup():
    actions = build_deterministic_checklist(_room(), "bedroom")
    assert [a.title for a in actions] == [
        "Group the book items",  # repeated label
        "Group technology accessories",  # compatible category (charger + cable)
        "Tidy the left side without moving the desk",  # the ONE cleanup, for what is left
        FINAL_CHECK_TITLE,
    ]
    assert [a.priority for a in actions] == [1, 2, 3, 4]


def test_fallback_no_longer_opens_with_an_unconditional_busiest_area_action():
    # the old shape started every checklist with "Start with the <area>" /
    # "Tidy the <area>" regardless of what the room contained
    for items in (_room(), _fixture_28()[0]):
        titles = [a.title for a in build_deterministic_checklist(items, "bedroom")]
        assert not any(
            t.startswith("Start with the") or re.fullmatch(r"Tidy the (?:left side|right side|centre|other areas)", t)
            for t in titles
        ), titles
        assert titles[0].startswith("Group the "), titles


def test_fallback_repeated_labels_come_before_compatible_groups_in_first_seen_order():
    items = [
        _item("item_001", "charger", "left"),
        _item("item_002", "cable", "left"),
        _item("item_003", "cup", "right"),
        _item("item_004", "toy", "right"),
        _item("item_005", "cup", "center"),
        _item("item_006", "toy", "center"),
    ]
    titles = [a.title for a in build_deterministic_checklist(items, "bedroom")]
    assert titles == ["Group the cup items", "Group the toy items", "Group technology accessories", FINAL_CHECK_TITLE]


# -- coverage: grouped items are never narrated again --------------------------


def test_fallback_excludes_covered_items_from_the_remaining_area_calculation():
    # three books on the left (covered by their group) and one lamp on
    # the right: the cleanup is for the lamp, not for the busier left side
    items = [
        _item("item_001", "book", "left"),
        _item("item_002", "book", "left"),
        _item("item_003", "book", "lower-left"),
        _item("item_004", "lamp", "right"),
    ]
    titles = [a.title for a in build_deterministic_checklist(items, "bedroom")]
    assert titles == ["Group the book items", "Straighten the lamp", FINAL_CHECK_TITLE]
    assert not any("left" in t for t in titles)


def test_fallback_compatible_group_items_are_covered_too():
    # charger + cable on the left are grouped; only the plant on the right remains
    items = [_item("item_001", "charger", "left"), _item("item_002", "cable", "left"), _item("item_003", "plant", "right")]
    titles = [a.title for a in build_deterministic_checklist(items, "bedroom")]
    assert titles == ["Group technology accessories", "Straighten the plant", FINAL_CHECK_TITLE]


def test_fallback_emits_no_cleanup_when_every_item_is_covered():
    items = [_item("item_001", "cup", "left"), _item("item_002", "cup", "right")]
    titles = [a.title for a in build_deterministic_checklist(items, "bedroom")]
    assert titles == ["Group the cup items", FINAL_CHECK_TITLE]


# -- at most one cleanup action -----------------------------------------------


def test_fallback_produces_at_most_one_cleanup_action_for_the_busiest_remaining_area():
    # nothing groups; items are spread over three areas, busiest is the centre
    items = [
        _item("item_001", "lamp", "left"),
        _item("item_002", "chair", "center", "medium"),
        _item("item_003", "bottle", "center"),
        _item("item_004", "plant", "right"),
    ]
    actions = build_deterministic_checklist(items, "bedroom")
    cleanups = [a for a in actions if CLEANUP_TITLE.match(a.title)]
    assert len(cleanups) == 1
    assert cleanups[0].title == "Tidy loose items in the centre"
    assert cleanups[0].instruction == "Straighten the chair and bottle, then clear the surrounding space."
    assert [a.title for a in actions] == ["Tidy loose items in the centre", FINAL_CHECK_TITLE]


def test_fallback_says_on_the_side_in_the_centre_and_in_other_areas():
    left = build_deterministic_checklist([_item("item_001", "lamp", "left"), _item("item_002", "chair", "lower-left")], "bedroom")
    right = build_deterministic_checklist([_item("item_001", "lamp", "right"), _item("item_002", "chair", "upper-right")], "bedroom")
    other = build_deterministic_checklist([_item("item_001", "lamp", "middle"), _item("item_002", "chair", "middle")], "bedroom")
    assert left[0].title == "Tidy loose items on the left side"
    assert right[0].title == "Tidy loose items on the right side"
    assert other[0].title == "Tidy loose items in other areas"


# -- the cleanup names only real, uncovered, selected items --------------------


def test_fallback_single_remaining_item_is_named_and_straightened():
    actions = build_deterministic_checklist([_item("item_001", "lamp", "center")], "bedroom")
    assert [a.title for a in actions] == ["Straighten the lamp", FINAL_CHECK_TITLE]
    assert actions[0].instruction == "Set it neatly in place and clear the immediate space around it."
    assert "bedroom" in actions[1].instruction


def test_fallback_names_a_large_anchor_only_when_that_exact_selected_item_is_large():
    # small + medium only: nothing is told to stay put and nothing is invented
    items = [_item("item_001", "cup", "left"), _item("item_002", "chair", "left", "medium")]
    first = build_deterministic_checklist(items, "bedroom")[0]
    assert first.title == "Tidy loose items on the left side"
    assert first.instruction == "Straighten the cup and chair, then clear the surrounding space."
    assert "Leave" not in first.instruction and "without moving" not in first.title

    # a large item that IS selected is named, verbatim, as the landmark
    items = [_item("item_001", "cup", "left"), _item("item_002", "wardrobe unit", "left", "large")]
    first = build_deterministic_checklist(items, "bedroom")[0]
    assert first.title == "Tidy the left side without moving the wardrobe unit"
    assert first.instruction == "Leave the wardrobe unit in place, then straighten the cup in the area."
    assert not UNSUPPORTED_PROXIMITY.search(first.instruction)

    # a large item that is NOT selected cannot be named: only the selection is seen
    items = [_item("item_001", "cup", "left"), _item("item_002", "chair", "left", "medium")]
    text = " ".join(f"{a.title} {a.instruction}" for a in build_deterministic_checklist(items, "bedroom"))
    assert "wardrobe" not in text and "shelf" not in text


def test_fallback_anchor_is_an_uncovered_item_in_the_busiest_remaining_area():
    # the large desk sits on the left with two books; the books are
    # covered by their group, so the desk is the only remaining left item
    items = [
        _item("item_001", "book", "left"),
        _item("item_002", "book", "left"),
        _item("item_003", "desk", "left", "large"),
        _item("item_004", "lamp", "right"),
        _item("item_005", "plant", "right"),
    ]
    titles = [a.title for a in build_deterministic_checklist(items, "bedroom")]
    # right (2 uncovered) beats left (1 uncovered): the desk is not the anchor
    assert titles == ["Group the book items", "Tidy loose items on the right side", FINAL_CHECK_TITLE]


def test_fallback_large_items_alone_get_a_clear_the_space_action():
    one = build_deterministic_checklist([_item("item_001", "wardrobe", "center", "large")], "bedroom")
    assert one[0].title == "Clear the space around the wardrobe"
    assert one[0].instruction == "Leave it in place and clear the immediate space around it."
    two = build_deterministic_checklist(
        [_item("item_001", "wardrobe", "left", "large"), _item("item_002", "desk", "left", "large")], "bedroom"
    )
    assert two[0].title == "Clear the space around the wardrobe"
    assert two[0].instruction == "Leave the wardrobe and desk in place and clear the immediate space around them."


def test_fallback_never_arranges_unrelated_items_around_a_large_item():
    """Regression for the 28-item bedroom fixture, whose centre area holds
    a large shelf plus a chair, bowl, plate and bottle: the checklist used
    to say to arrange the chair and bowl around the shelf. The shelf may be
    named as the landmark of the space being tidied, never as somewhere
    to put things."""
    items = [
        _item("item_001", "shelf", "center", "large"),
        _item("item_002", "chair", "lower-center", "medium"),
        _item("item_003", "bowl", "center"),
        _item("item_004", "plate", "center"),
        _item("item_005", "bottle", "center"),
    ]
    actions = build_deterministic_checklist(items, "bedroom")
    assert actions[0].title == "Tidy the centre without moving the shelf"
    assert actions[0].instruction == (
        "Leave the shelf in place, then straighten the chair, bowl, plate and the other loose items in the area."
    )
    # at most three real labels are named; the rest is "the other loose
    # items" with no count, and nothing is said to be around the shelf
    assert "bottle" not in actions[0].instruction
    assert "around" not in actions[0].title and "around" not in actions[0].instruction
    for action in actions:
        assert not PLACEMENT.search(action.instruction), action.instruction
        assert not PLACEMENT.search(action.title), action.title
        assert not UNSUPPORTED_PROXIMITY.search(action.instruction), action.instruction


# -- the real 28-item fixture --------------------------------------------------


def test_fallback_on_the_real_28_item_fixture_is_a_concise_title_led_checklist():
    items, scene_label = _fixture_28()
    actions = build_deterministic_checklist(items, scene_label)

    # groups first (six picture frames, two toys, two cups), then the one
    # cleanup for the busiest uncovered area (the left side: ten items
    # remain there, none of them large), then the closing check
    assert [a.title for a in actions] == [
        "Group the picture frame items",
        "Group the toy items",
        "Group the cup items",
        "Tidy loose items on the left side",
        FINAL_CHECK_TITLE,
    ]
    assert [a.instruction for a in actions] == [
        "Keep all 6 together so they are easier to find and put back.",
        "Keep both together so they are easier to find and put back.",
        "Keep both together so they are easier to find and put back.",
        "Straighten the painting, jewelry, clock and the other loose items, then clear the surrounding space.",
        "Walk through the bedroom once more and make sure every selected item has a clear place.",
    ]
    assert len(actions) == MAX_ACTIONS


def test_fallback_on_the_real_28_item_fixture_gives_no_placement_advice_and_no_narration():
    items, scene_label = _fixture_28()
    actions = build_deterministic_checklist(items, scene_label)

    labels = {item.effective_label for item in items}
    text = " ".join(f"{a.title} {a.instruction}" for a in actions)
    assert not PLACEMENT.search(text), text
    assert not INVENTED.search(text.replace("shelf", "").replace("box", "").replace("bin", "")), text
    assert "books" not in text and "papers" not in text  # what the real v2 model run invented
    assert not NARRATION.search(text), text
    assert not UNSUPPORTED_PROXIMITY.search(text), text
    # the only number anywhere is the real picture-frame count; never an
    # "N more", a parenthesised inventory or an "x2"
    assert re.findall(r"\d+", text) == ["6"], text
    assert "(" not in text and " x2" not in text and not re.search(r"\d+ more", text)
    # the cleanup names at most three real uncovered labels, none of them grouped
    cleanup = next(a for a in actions if CLEANUP_TITLE.match(a.title))
    named = re.findall(r"Straighten the (.+?) and the other loose items", cleanup.instruction)
    assert named and [n.strip() for n in named[0].split(",")] == ["painting", "jewelry", "clock"]
    assert "picture frame" not in cleanup.instruction and "toy" not in cleanup.instruction and "cup" not in cleanup.instruction
    # short and readable: every step fits on a line
    for action in actions:
        assert len(action.title) <= 40, action.title
        assert len(action.instruction) <= 110, action.instruction
    # every grouped label is a real selected label
    for grouped in re.findall(r"Group the (.+?) items$", "\n".join(a.title for a in actions), re.M):
        assert grouped in labels, grouped


# -- titles and instructions -----------------------------------------------------


def _every_scenario():
    items, scene = _fixture_28()
    yield items, scene
    yield _room(), "bedroom"
    yield [_item("item_001", "lamp", "center")], "bedroom"
    yield [_item("item_001", "wardrobe", "center", "large")], "bedroom"
    yield [_item("item_001", "cup", "left"), _item("item_002", "cup", "right")], "living room"
    yield [_item("item_001", "lamp", "middle"), _item("item_002", "chair", "middle")], "bedroom"
    yield [_item("item_001", "shelf", "center", "large"), _item("item_002", "bowl", "center"), _item("item_003", "plate", "center")], "kitchen"


def test_fallback_titles_are_bounded_imperative_and_self_contained():
    for items, scene in _every_scenario():
        for action in build_deterministic_checklist(items, scene):
            assert TITLE_SHAPES.match(action.title), action.title
            assert TITLE_MIN_LENGTH <= len(action.title) <= TITLE_MAX_LENGTH, action.title
            assert action.title[0].isupper() and not action.title.endswith(".")
            assert not re.search(r"\d", action.title), action.title
            assert "(" not in action.title and ":" not in action.title, action.title
            assert not NARRATION.search(action.title), action.title


def test_fallback_instructions_remain_valid_and_within_the_existing_bounds():
    for items, scene in _every_scenario():
        actions = build_deterministic_checklist(items, scene)
        for action in actions:
            assert INSTRUCTION_MIN_LENGTH <= len(action.instruction) <= INSTRUCTION_MAX_LENGTH, action.instruction
            assert _one_sentence(action.instruction), action.instruction
            assert not NARRATION.search(action.instruction), action.instruction
            assert not UNSUPPORTED_PROXIMITY.search(action.instruction), action.instruction
            # a number appears only as a repeated-label group count
            digits = re.findall(r"\d+", action.instruction)
            assert not digits or action.instruction.startswith("Keep all "), action.instruction
            assert "(" not in action.instruction and not re.search(r"\d+ more", action.instruction), action.instruction
        # and the whole list still passes the strict model-facing schema
        assert parse_and_validate_actions({"actions": [a.model_dump() for a in actions]}).is_valid


def test_fallback_repeated_label_actions_keep_the_label_but_drop_position_and_inventory():
    items = [_item("item_001", "cup", "left"), _item("item_002", "cup", "lower-left"), _item("item_003", "toy", "center"), _item("item_004", "toy", "center")]
    actions = build_deterministic_checklist(items, "bedroom")
    grouped = [a for a in actions if a.title.startswith("Group the ")]
    assert [a.title for a in grouped] == ["Group the cup items", "Group the toy items"]
    assert [a.instruction for a in grouped] == [
        "Keep both together so they are easier to find and put back.",
        "Keep both together so they are easier to find and put back.",
    ]
    for action in grouped:
        assert not POSITION_WORDS.search(action.instruction), action.instruction
        assert not POSITION_WORDS.search(action.title), action.title


def test_fallback_repeated_label_instruction_uses_the_real_count_for_three_or_more():
    items = [_item("item_001", "cup", "left"), _item("item_002", "cup", "right"), _item("item_003", "cup", "center")]
    actions = build_deterministic_checklist(items, "bedroom")
    assert actions[0].title == "Group the cup items"
    assert actions[0].instruction == "Keep all 3 together so they are easier to find and put back."
    assert not POSITION_WORDS.search(actions[0].instruction)
    six = [_item(f"item_{n:03d}", "sock", ["left", "right", "center"][n % 3]) for n in range(1, 7)]
    assert build_deterministic_checklist(six, "bedroom")[0].instruction == (
        "Keep all 6 together so they are easier to find and put back."
    )


def test_fallback_compatible_group_titles_are_concise_without_a_label_inventory():
    actions = build_deterministic_checklist(_room(), "bedroom")
    by_title = {a.title: a.instruction for a in actions}
    assert by_title["Group the book items"] == "Keep both together so they are easier to find and put back."
    assert by_title["Group technology accessories"] == (
        "Keep these related items together so they are easy to find and put back."
    )
    # neither instruction repeats its title or names where the items are
    for title, instruction in by_title.items():
        assert instruction.lower() != title.lower() + "."
        assert not POSITION_WORDS.search(instruction) or CLEANUP_TITLE.match(title), (title, instruction)


def test_fallback_compatible_groups_accept_only_small_and_medium_items():
    """Storage may treat two large coats or bags as hanging-organiser
    evidence; the checklist keeps its original small/medium-only
    eligibility, so the same items never become a "Group clothing, bags
    and shoes" step (regression for the storage-sizes rework)."""
    from app.core.reorganise_storage import derive_storage_suggestions

    large = [_item("item_001", "backpack", "left", "large"), _item("item_002", "coat", "right", "large")]
    assert [rec.name for rec in derive_storage_suggestions(large)] == ["Hooks or a hanging organiser"]
    titles = [a.title for a in build_deterministic_checklist(large, "bedroom")]
    assert not any(t.startswith("Group ") for t in titles), titles
    # both are plain uncovered items; the busiest area (left, one large item) gets the cleanup
    assert titles == ["Clear the space around the backpack", FINAL_CHECK_TITLE]

    # small + medium: grouped in the checklist exactly as before
    smaller = [_item("item_001", "backpack", "left", "small"), _item("item_002", "coat", "right", "medium")]
    assert [a.title for a in build_deterministic_checklist(smaller, "bedroom")] == [
        "Group clothing, bags and shoes",
        FINAL_CHECK_TITLE,
    ]
    # a large item drops out of a group its smaller companions still form,
    # and is then a plain uncovered item for the cleanup step
    mixed = smaller + [_item("item_003", "jacket", "left", "large")]
    actions = build_deterministic_checklist(mixed, "bedroom")
    assert [a.title for a in actions] == [
        "Group clothing, bags and shoes",
        "Clear the space around the jacket",
        FINAL_CHECK_TITLE,
    ]


def test_fallback_compatible_groups_need_evidence():
    # a single accessory is not a group; a book alone is not a "books and papers" group
    actions = build_deterministic_checklist([_item("item_001", "cable", "left"), _item("item_002", "book", "right")], "bedroom")
    assert not any(a.title.startswith("Group ") for a in actions), [a.title for a in actions]


# -- the final check and the cap -------------------------------------------------


def test_fallback_final_check_appears_when_capacity_remains_and_names_the_room_type():
    actions = build_deterministic_checklist([_item("item_001", "lamp"), _item("item_002", "chair", "right")], "living room")
    assert actions[-1].title == FINAL_CHECK_TITLE
    assert actions[-1].instruction == (
        "Walk through the living room once more and make sure every selected item has a clear place."
    )


def test_fallback_instructions_add_to_their_titles_instead_of_restating_them():
    for items, scene in _every_scenario():
        for action in build_deterministic_checklist(items, scene):
            title_words = set(re.findall(r"[a-z]+", action.title.lower())) - {"the", "a", "and", "of", "in", "on"}
            instruction_words = set(re.findall(r"[a-z]+", action.instruction.lower())) - {"the", "a", "and", "of", "in", "on"}
            assert instruction_words - title_words, (action.title, action.instruction)  # says something new
            assert action.instruction.rstrip(".").lower() != action.title.lower()


def test_fallback_area_cleanup_names_at_most_three_real_labels_then_the_other_loose_items():
    labels = ["lamp", "chair", "plant", "clock", "bottle"]
    items = [_item(f"item_{n:03d}", label, "left") for n, label in enumerate(labels, start=1)]
    actions = build_deterministic_checklist(items, "bedroom")
    assert actions[0].title == "Tidy loose items on the left side"
    assert actions[0].instruction == (
        "Straighten the lamp, chair, plant and the other loose items, then clear the surrounding space."
    )
    assert "clock" not in actions[0].instruction and "bottle" not in actions[0].instruction
    assert not re.search(r"\d", actions[0].instruction)  # never an "N more" tail
    # exactly three, or fewer, are named in full without the tail
    three = build_deterministic_checklist(items[:3], "bedroom")[0].instruction
    assert three == "Straighten the lamp, chair and plant, then clear the surrounding space."
    two = build_deterministic_checklist(items[:2], "bedroom")[0].instruction
    assert two == "Straighten the lamp and chair, then clear the surrounding space."


def test_fallback_anchor_cleanup_names_at_most_three_of_the_smaller_items_and_no_proximity():
    items = [_item("item_001", "shelf", "right", "large")] + [
        _item(f"item_{n:03d}", label, "right") for n, label in enumerate(["lamp", "chair", "plant", "clock"], start=2)
    ]
    first = build_deterministic_checklist(items, "bedroom")[0]
    assert first.title == "Tidy the right side without moving the shelf"
    assert first.instruction == (
        "Leave the shelf in place, then straighten the lamp, chair, plant and the other loose items in the area."
    )
    assert "clock" not in first.instruction
    assert not UNSUPPORTED_PROXIMITY.search(first.instruction)
    assert not re.search(r"\b(?:around|on|beside|next to|near) the shelf\b", f"{first.title} {first.instruction}")


def test_fallback_final_check_never_displaces_an_evidence_backed_action():
    # four repeated-label groups + one cleanup fill the list: no final check
    items = [
        _item("item_001", "cup"), _item("item_002", "cup"),
        _item("item_003", "toy"), _item("item_004", "toy"),
        _item("item_005", "book"), _item("item_006", "book"),
        _item("item_007", "pen"), _item("item_008", "pen"),
        _item("item_009", "lamp"),
    ]
    titles = [a.title for a in build_deterministic_checklist(items, "bedroom")]
    assert titles == [
        "Group the cup items",
        "Group the toy items",
        "Group the book items",
        "Group the pen items",
        "Straighten the lamp",
    ]
    assert FINAL_CHECK_TITLE not in titles


def test_fallback_enforces_max_actions_with_sequential_priorities():
    # six repeated labels would be six groups: capped at MAX_ACTIONS, all groups
    items = []
    for n, label in enumerate(["cup", "toy", "book", "pen", "sock", "hat"], start=1):
        items.append(_item(f"item_{2 * n - 1:03d}", label))
        items.append(_item(f"item_{2 * n:03d}", label, "right"))
    actions = build_deterministic_checklist(items, "bedroom")
    assert len(actions) == MAX_ACTIONS == 5
    assert [a.priority for a in actions] == [1, 2, 3, 4, 5]
    assert all(a.title.startswith("Group the ") for a in actions)
    for items, scene in _every_scenario():
        actions = build_deterministic_checklist(items, scene)
        assert 1 <= len(actions) <= MAX_ACTIONS
        assert [a.priority for a in actions] == list(range(1, len(actions) + 1))


# -- invariants --------------------------------------------------------------------


def test_fallback_never_invents_storage_furniture_or_destinations():
    for items, scene in _every_scenario():
        for action in build_deterministic_checklist(items, scene):
            selected = {item.effective_label for item in items}
            # a furniture word may appear only because it IS a selected label
            for hit in INVENTED.findall(f"{action.title} {action.instruction}"):
                assert hit.lower() in selected, (hit, action.title)
            assert find_forbidden_content(f"{action.title} {action.instruction}") is None


def test_fallback_uses_corrected_labels_not_detector_labels():
    items = [_item("item_001", "vase", corrected="table lamp"), _item("item_002", "vase", corrected="table lamp")]
    text = " ".join(f"{a.title} {a.instruction}" for a in build_deterministic_checklist(items, "bedroom"))
    assert "table lamp" in text
    assert "vase" not in text


def test_fallback_survives_very_long_corrected_labels_within_the_schema_bounds():
    long_label = ("a very long user supplied corrected label " * 12).strip()
    items = [
        _item("item_001", "x", "left", corrected=long_label + " book"),
        _item("item_002", "x", "left", corrected=long_label + " book"),
        _item("item_003", "x", "right", "large", corrected=long_label + " desk"),
        _item("item_004", "x", "right", corrected=long_label + " cable"),
        _item("item_005", "x", "center", corrected=long_label + " charger"),
    ]
    actions = build_deterministic_checklist(items, "x" * 200)
    assert 1 <= len(actions) <= MAX_ACTIONS
    for action in actions:
        assert TITLE_MIN_LENGTH <= len(action.title) <= TITLE_MAX_LENGTH
        assert INSTRUCTION_MIN_LENGTH <= len(action.instruction) <= INSTRUCTION_MAX_LENGTH
    # the long large-item label is still the only thing told to stay put, and it is bounded for display
    large_area = next(a for a in actions if a.instruction.startswith("Leave "))
    assert large_area.title.startswith("Clear the space around the ")
    # an anchor plus several long-labelled loose items still fits the bounds
    crowded = [_item("item_001", "x", "left", "large", corrected=long_label + " desk")] + [
        _item(f"item_{n:03d}", "x", "left", corrected=f"{long_label} thing{n}") for n in range(2, 8)
    ]
    for action in build_deterministic_checklist(crowded, "bedroom"):
        assert TITLE_MIN_LENGTH <= len(action.title) <= TITLE_MAX_LENGTH
        assert INSTRUCTION_MIN_LENGTH <= len(action.instruction) <= INSTRUCTION_MAX_LENGTH
    assert parse_and_validate_actions({"actions": [a.model_dump() for a in actions]}).is_valid


def test_fallback_schema_bounds_and_cap_are_unchanged():
    # the response shape the frontend contract validates against is untouched
    assert (MIN_ACTIONS, MAX_ACTIONS) == (1, 5)
    assert (TITLE_MIN_LENGTH, TITLE_MAX_LENGTH) == (3, 80)
    assert (INSTRUCTION_MIN_LENGTH, INSTRUCTION_MAX_LENGTH) == (10, 300)
    assert set(ReorganiseAction.model_fields) == {"priority", "title", "instruction"}


def test_fallback_output_passes_its_own_strict_schema():
    actions = build_deterministic_checklist(_room(), "bedroom")
    raw = {"actions": [a.model_dump() for a in actions]}
    assert parse_and_validate_actions(raw).is_valid


def test_fallback_never_reads_user_context():
    import inspect

    from app.core import reorganise_actions

    assert "user_context" not in inspect.signature(reorganise_actions.build_deterministic_checklist).parameters


def test_fallback_module_makes_no_model_call():
    import inspect

    from app.core import reorganise_actions

    source = inspect.getsource(reorganise_actions)
    assert "ollama" not in source and "httpx" not in source and "requests" not in source
    assert "generate_reorganise_actions_once" not in source


@pytest.mark.parametrize("bad_items", [[], None, ["lamp"]])
def test_fallback_rejects_malformed_selection(bad_items):
    with pytest.raises(ValueError):
        build_deterministic_checklist(bad_items, "bedroom")


def test_fallback_rejects_duplicate_ids_and_blank_scene():
    with pytest.raises(ValueError, match="duplicate"):
        build_deterministic_checklist([_item("item_001", "lamp"), _item("item_001", "lamp")], "bedroom")
    with pytest.raises(ValueError, match="scene_label"):
        build_deterministic_checklist([_item("item_001", "lamp")], " ")
