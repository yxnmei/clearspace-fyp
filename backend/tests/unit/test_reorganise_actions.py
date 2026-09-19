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
    MAX_ACTIONS,
    TITLE_MAX_LENGTH,
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


def test_fallback_is_deterministic():
    assert build_deterministic_checklist(_room(), "bedroom") == build_deterministic_checklist(_room(), "bedroom")


def test_fallback_starts_with_the_busiest_area():
    actions = build_deterministic_checklist(_room(), "bedroom")
    assert actions[0].priority == 1
    assert actions[0].title == "Start with the left side"
    assert "holds 3 of your selected items" in actions[0].instruction


def test_fallback_uses_size_only_to_say_a_large_item_stays_put():
    first = build_deterministic_checklist(_room(), "bedroom")[0].instruction
    assert "Leave the desk where it is." in first
    assert "Straighten the lamp and book" in first


# Placement advice the fallback must never give: arranging things around,
# on, beside or next to another item assumes a relationship, a surface or
# a destination that nothing in the detection data supports.
# ("the space around them" is each item's own surroundings and is fine;
# what is banned is arranging one item relative to ANOTHER.)
PLACEMENT = re.compile(r"\b(arrange\w*|beside|next to|on top|onto|on the \w+ (?:shelf|desk|table)|into the|inside|neatly around)\b", re.I)


def test_fallback_never_arranges_unrelated_items_around_a_large_item():
    """Regression for the 28-item bedroom fixture, whose centre area holds
    a large shelf plus a chair, bowl, plate and bottle: the checklist used
    to say to arrange the chair and bowl around the shelf."""
    items = [
        _item("item_001", "shelf", "center", "large"),
        _item("item_002", "chair", "lower-center", "medium"),
        _item("item_003", "bowl", "center"),
        _item("item_004", "plate", "center"),
        _item("item_005", "bottle", "center"),
    ]
    actions = build_deterministic_checklist(items, "bedroom")
    first = actions[0].instruction

    assert "Leave the shelf where it is." in first
    assert "Straighten the chair, bowl, plate and 1 more" in first
    assert "around each one" in first  # each item's own space, not the shelf
    for action in actions:
        assert not PLACEMENT.search(action.instruction), action.instruction
        assert not PLACEMENT.search(action.title), action.title


def test_fallback_on_the_real_28_item_fixture_gives_no_placement_advice():
    import json
    from pathlib import Path

    fixture = Path(__file__).resolve().parents[2] / "evaluation" / "fixtures" / "reorganise_bedroom02_28items.json"
    raw = json.loads(fixture.read_text(encoding="utf-8"))
    items = [DetectedItem.model_validate(entry) for entry in raw["items"]]

    actions = build_deterministic_checklist(items, raw["scene_label"])

    labels = {item.effective_label for item in items}
    text = " ".join(f"{a.title} {a.instruction}" for a in actions)
    assert "Leave the shelf where it is." in text
    assert "around the shelf" not in text
    assert not PLACEMENT.search(text), text
    assert not INVENTED.search(text.replace("shelf", "").replace("box", "").replace("bin", "")), text
    assert "books" not in text and "papers" not in text  # what the real v2 model run invented
    # every quoted label is a real selected label
    for quoted in re.findall(r"labelled '([^']+)'", text):
        assert quoted in labels, quoted


def test_fallback_says_on_the_side_and_in_the_centre():
    items = [_item("item_001", "cup", "left"), _item("item_002", "cup", "lower-left"), _item("item_003", "toy", "center"), _item("item_004", "toy", "center")]
    text = " ".join(a.instruction for a in build_deterministic_checklist(items, "bedroom"))
    assert "currently on the left side" in text
    assert "currently in the centre" in text
    assert "in the left side" not in text


def test_fallback_mentions_repeated_labels_and_compatible_groups():
    titles = [a.title for a in build_deterministic_checklist(_room(), "bedroom")]
    assert "Group the book items together" in titles
    assert "Keep the technology accessories together" in titles


def test_fallback_priorities_are_sequential_and_capped_at_five():
    actions = build_deterministic_checklist(_room(), "bedroom")
    assert [a.priority for a in actions] == list(range(1, len(actions) + 1))
    assert 1 <= len(actions) <= MAX_ACTIONS


def test_fallback_never_invents_storage_furniture_or_destinations():
    for action in build_deterministic_checklist(_room(), "bedroom"):
        assert not INVENTED.search(action.title), action.title
        assert not INVENTED.search(action.instruction), action.instruction
        assert find_forbidden_content(f"{action.title} {action.instruction}") is None


def test_fallback_for_a_single_item_is_short_and_names_only_that_item():
    actions = build_deterministic_checklist([_item("item_001", "lamp", "center")], "bedroom")
    assert [a.title for a in actions] == ["Start with the centre", "Check the whole room"]
    assert "lamp" in actions[0].instruction
    assert "Straighten it" in actions[0].instruction
    assert "bedroom" in actions[1].instruction


def test_fallback_closing_check_names_the_room_type_when_there_is_space():
    actions = build_deterministic_checklist([_item("item_001", "lamp"), _item("item_002", "chair", "right")], "living room")
    assert actions[-1].title == "Check the whole room"
    assert "living room" in actions[-1].instruction


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
        assert len(action.title) <= TITLE_MAX_LENGTH
        assert len(action.instruction) <= INSTRUCTION_MAX_LENGTH


def test_fallback_output_passes_its_own_strict_schema():
    actions = build_deterministic_checklist(_room(), "bedroom")
    raw = {"actions": [a.model_dump() for a in actions]}
    assert parse_and_validate_actions(raw).is_valid


def test_fallback_never_reads_user_context():
    import inspect

    from app.core import reorganise_actions

    assert "user_context" not in inspect.signature(reorganise_actions.build_deterministic_checklist).parameters


@pytest.mark.parametrize("bad_items", [[], None, ["lamp"]])
def test_fallback_rejects_malformed_selection(bad_items):
    with pytest.raises(ValueError):
        build_deterministic_checklist(bad_items, "bedroom")


def test_fallback_rejects_duplicate_ids_and_blank_scene():
    with pytest.raises(ValueError, match="duplicate"):
        build_deterministic_checklist([_item("item_001", "lamp"), _item("item_001", "lamp")], "bedroom")
    with pytest.raises(ValueError, match="scene_label"):
        build_deterministic_checklist([_item("item_001", "lamp")], " ")
