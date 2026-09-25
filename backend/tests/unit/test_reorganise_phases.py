"""Fake-free tests of the pure phased tidy-plan builder; no model calls."""

import re

import pytest
from pydantic import ValidationError

from app.core.reorganise_actions import _FORBIDDEN_CONTENT_RE
from app.core.reorganise_phases import PHASE_ORDER, TidyPlan, build_tidy_plan
from app.core.schemas import BoundingBox, Decision, DetectedItem


def item(number: int, label: str, size: str = "small") -> DetectedItem:
    return DetectedItem(
        item_id=f"item_{number:03d}", source_detection_index=number,
        raw_phrase=label, clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.2, y2=0.2),
        confidence=0.9, position="upper-left", relative_size=size,
    )


def all_steps(plan):
    return [step for phase in plan.phases for step in phase.steps]


@pytest.mark.parametrize("scene,expected", [
    ("home office desk", "desk surface"), ("bedroom", "bedside surfaces"),
    ("wardrobe / closet", "bedside surfaces"), ("kitchen", "counters"),
    ("dining room", "counters"), ("garage", "main surfaces"), ("unknown", "main surfaces"),
])
def test_room_template_selection(scene, expected):
    plan = build_tidy_plan([item(1, "lamp")], scene)
    assert expected in " ".join(step.text for step in plan.phases[0].steps)
    ids = [phase.phase_id for phase in plan.phases]
    assert ids == [phase for phase in PHASE_ORDER if phase in ids]
    assert ids[0] == "empty_clean" and ids[-1] == "maintain"


def test_evidence_gates_cables_zones_and_tray():
    bare = build_tidy_plan([item(1, "chair", "large")], "garage")
    assert "cables" not in [phase.phase_id for phase in bare.phases]
    assert "zones" not in [phase.phase_id for phase in bare.phases]
    with_cables = build_tidy_plan([item(1, "cable"), item(2, "cord")], "garage")
    assert "cables" in [phase.phase_id for phase in with_cables.phases]
    assert not any("tray" in step.text.lower() for step in all_steps(with_cables))
    one_small = build_tidy_plan([item(1, "key")], "garage")
    assert not any("tray" in step.text.lower() for step in all_steps(one_small))
    two_cups = build_tidy_plan([item(1, "cup"), item(2, "cup")], "bedroom")
    assert not any("tray" in step.text.lower() for step in all_steps(two_cups))
    keys_and_watch = build_tidy_plan([item(1, "keys"), item(2, "watch")], "bedroom")
    tray = next(step for step in all_steps(keys_and_watch) if "tray" in step.text.lower())
    assert "keys and watch" in tray.text
    assert tray.item_ids == ["item_001", "item_002"]
    assert _FORBIDDEN_CONTENT_RE.search(tray.text) is None
    assert not re.search(r"\b(?:left|right|centre|center|upper|lower)\b", tray.text, re.I)


def test_repeated_furniture_soft_furnishings_and_large_items_have_no_store_the_rest_step():
    items = [item(1, "shelf"), item(2, "shelf"), item(3, "pillow"), item(4, "pillow"),
             item(5, "lamp", "large"), item(6, "lamp", "large")]
    plan = build_tidy_plan(items, "bedroom")
    assert not any("Decide which one you use daily and store the rest" in step.text for step in all_steps(plan))


def test_surface_aware_opening_precedes_room_template_and_carries_ids():
    with_surface = build_tidy_plan([item(1, "desk", "large"), item(2, "shelf", "large")], "bedroom")
    opening = with_surface.phases[0].steps
    assert opening[0].text == "Clear the desk and shelf first. That is where loose items collect."
    assert opening[0].item_ids == ["item_001", "item_002"]
    assert _FORBIDDEN_CONTENT_RE.search(opening[0].text) is None
    assert not re.search(r"\b(?:left|right|centre|center|upper|lower)\b", opening[0].text, re.I)
    assert opening[1].text == "Clear the bed, the bedside surfaces and the floor."
    without_surface = build_tidy_plan([item(1, "lamp")], "bedroom")
    assert without_surface.phases[0].steps[0].text == "Clear the bed, the bedside surfaces and the floor."


def test_kitchen_glasses_and_bedroom_eyewear_are_not_conflated():
    kitchen = build_tidy_plan([item(1, "glasses")], "kitchen")
    bedroom = build_tidy_plan([item(1, "glasses")], "bedroom")
    assert any("glasses" in step.text for step in kitchen.phases[1].steps)
    assert not any("glasses" in step.text for step in bedroom.phases[1].steps)


def test_repeated_labels_and_cap_drop_repeated_before_tray():
    items = [item(1, "lamp"), item(2, "lamp"), item(3, "book"), item(4, "book"),
             item(5, "cable"), item(6, "cable"), item(7, "pillow"), item(8, "key"), item(9, "watch")]
    plan = build_tidy_plan(items, "home office desk")
    zones = next(phase for phase in plan.phases if phase.phase_id == "zones")
    assert len(zones.steps) == 6
    assert sum(step.text.startswith("You have") for step in zones.steps) == 2
    assert any("tray" in step.text.lower() for step in zones.steps)
    assert all(step.step_id == f"zones-{index}" for index, step in enumerate(zones.steps, 1))


def test_both_departing_steps_are_split_by_decision_and_ids():
    departing = [(item(2, "laptop"), Decision.SELL), (item(3, "book"), Decision.DONATE),
                 (item(4, "box"), Decision.DISCARD), (item(5, "monitor"), Decision.SELL)]
    plan = build_tidy_plan([item(1, "lamp")], "bedroom", departing)
    sort_steps = next(phase for phase in plan.phases if phase.phase_id == "sort").steps
    assert [(step.text.split(":")[0], step.item_ids) for step in sort_steps if step.item_ids] == [
        ("Set aside to sell", ["item_002", "item_005"]),
        ("Set aside to donate", ["item_003"]),
        ("Throw out or recycle", ["item_004"]),
    ]


@pytest.mark.parametrize("scene", ["bedroom", "garage"])
def test_sort_cap_preserves_fixed_and_all_three_departing_steps(scene):
    selected = [item(1, "shirt"), item(2, "book"), item(3, "cup")]
    departing = [(item(4, "monitor"), Decision.SELL), (item(5, "toy"), Decision.DONATE),
                 (item(6, "box"), Decision.DISCARD)]
    plan = build_tidy_plan(selected, scene, departing)
    sort_steps = next(phase for phase in plan.phases if phase.phase_id == "sort").steps
    assert len(sort_steps) == 6
    assert sort_steps[0].item_ids == []  # the fixed method step is retained
    assert [step.item_ids for step in sort_steps if any(word in step.text for word in ("sell:", "donate:", "recycle:"))] == [
        ["item_004"], ["item_005"], ["item_006"],
    ]


@pytest.mark.parametrize("scene", ["home office desk", "bedroom", "kitchen", "garage"])
def test_named_labels_carry_their_ids_and_commercial_content_is_absent(scene):
    items = [item(1, "mouse"), item(2, "cable"), item(3, "book")]
    plan = build_tidy_plan(items, scene)
    for step in all_steps(plan):
        assert _FORBIDDEN_CONTENT_RE.search(step.text) is None
        assert not re.search(r"\b(?:left|right|centre|center|upper|lower)\b", step.text, re.I)
        for selected in items:
            if selected.effective_label in step.text:
                assert selected.item_id in step.item_ids
    assert [phase.phase_id for phase in plan.phases] == [p for p in PHASE_ORDER if p in {x.phase_id for x in plan.phases}]


@pytest.mark.parametrize("selection,scene,departing", [
    ([], "bedroom", None), (["bad"], "bedroom", None),
    ([item(1, "lamp"), item(1, "lamp")], "bedroom", None),
    ([item(1, "lamp")], " ", None),
    ([item(1, "lamp")], "bedroom", [(item(1, "lamp"), Decision.SELL)]),
    ([item(1, "lamp")], "bedroom", [(item(2, "book"), Decision.KEEP)]),
    ([item(1, "lamp")], "bedroom", [(item(2, "book"), Decision.SELL), (item(2, "book"), Decision.SELL)]),
])
def test_invalid_inputs_raise_value_error(selection, scene, departing):
    with pytest.raises(ValueError):
        build_tidy_plan(selection, scene, departing)


def test_schema_rejects_duplicate_or_out_of_order_phase():
    plan = build_tidy_plan([item(1, "lamp")], "bedroom")
    with pytest.raises(ValidationError):
        TidyPlan(phases=list(reversed(plan.phases)))
    with pytest.raises(ValidationError):
        TidyPlan(phases=[plan.phases[0], plan.phases[0]])


def test_natural_phrasing_uses_known_plurals_and_complete_sentences():
    selected = [item(1, "desk", "large"), item(2, "shelf", "large"), item(3, "shelf", "large")]
    departing = [(item(4, "box"), Decision.DISCARD), (item(5, "bottle"), Decision.DISCARD),
                 (item(6, "bottle"), Decision.DISCARD), (item(7, "bottle"), Decision.DISCARD),
                 (item(8, "printer"), Decision.SELL), (item(9, "chair"), Decision.SELL)]
    plan = build_tidy_plan(selected, "bedroom", departing)
    texts = [step.text for step in all_steps(plan)]
    assert texts[0] == "Clear the desk and 2 shelves first. That is where loose items collect."
    assert "Set aside to sell: the printer and chair." in texts
    assert "Throw out or recycle: the box and 3 bottles." in texts
    sell = next(step for step in all_steps(plan) if step.text.startswith("Set aside to sell"))
    assert sell.item_ids == ["item_008", "item_009"]


def test_natural_phrasing_never_guesses_a_plural_for_an_unknown_label():
    corrected = [item(1, "book").model_copy(update={"corrected_label": "gundam"}),
                 item(2, "book").model_copy(update={"corrected_label": "gundam"})]
    plan = build_tidy_plan([item(3, "lamp")], "bedroom", [(x, Decision.SELL) for x in corrected])
    assert "Set aside to sell: the 2 gundam items." in [step.text for step in all_steps(plan)]
    repeated = build_tidy_plan([item(1, "cup"), item(2, "cup"), item(3, "cup")], "home office desk")
    assert any(step.text == "You have 3 cups. Decide which one you use daily and store the rest." for step in all_steps(repeated))


def test_no_step_text_uses_the_label_xn_form():
    items = [item(n, label) for n, label in enumerate(
        ["cup", "cup", "book", "book", "book", "cable", "cable", "pillow", "pillow", "key", "watch", "pen"], 1)]
    departing = [(item(20, "bottle"), Decision.DISCARD), (item(21, "bottle"), Decision.DISCARD)]
    for scene in ("home office desk", "bedroom", "kitchen", "garage"):
        plan = build_tidy_plan(items, scene, departing)
        for step in all_steps(plan):
            assert not re.search(r"\bx\d", step.text), step.text
            assert step.text.endswith("."), step.text


def test_determinism_and_long_corrected_label():
    long_label = "very long corrected label " * 30 + " book"
    chosen = item(1, "book").model_copy(update={"corrected_label": long_label})
    plan = build_tidy_plan([chosen, item(2, "book")], "bedroom")
    assert plan == build_tidy_plan([chosen, item(2, "book")], "bedroom")
    assert all(len(step.text) <= 300 for step in all_steps(plan))
