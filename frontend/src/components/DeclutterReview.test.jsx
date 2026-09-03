import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterReview from "./DeclutterReview";

function makeAnalysis(overrides = {}) {
  return {
    run_id: "run1",
    scene: { label: "bedroom", confidence: 0.9604, all_scores: { bedroom: 0.9604 } },
    items: [],
    warnings: [],
    stage_timings: [
      { stage: "validate_image", duration_ms: 10 },
      { stage: "classify_scene", duration_ms: 4500 },
    ],
    ...overrides,
  };
}

function makeDeclutter(overrides = {}) {
  return {
    run_id: "run1",
    expected_item_ids: [],
    ai_decisions: [],
    unresolved_item_ids: [],
    item_validity: {},
    mapping_warnings: [],
    semantic_errors: [],
    recovery_failures: [],
    provenance_warnings: [],
    is_complete: true,
    is_strictly_valid: true,
    model_name: "phi4-mini",
    prompt_version: "v2",
    stage_timings: [],
    ...overrides,
  };
}

function makeResolvedReviewItem(overrides = {}) {
  const cleanLabel = overrides.clean_label ?? "lamp";
  const correctedLabel = "corrected_label" in overrides ? overrides.corrected_label : null;
  return {
    item_id: "item_001",
    raw_phrase: "lamp",
    clean_label: cleanLabel,
    position: "upper-left",
    relative_size: "small",
    confidence: 0.8,
    box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
    ai_decision: "keep",
    ai_reason: "still useful",
    item_validity: "raw_valid",
    is_expected: true,
    is_unresolved: false,
    review_decision: "keep",
    review_excluded: false,
    review_user_reason: null,
    decision_changed: false,
    has_decision_override: false,
    corrected_label: correctedLabel,
    label_source: correctedLabel !== null ? "user" : "detector",
    effective_label: correctedLabel !== null ? correctedLabel : cleanLabel,
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    analysis: makeAnalysis(),
    declutter: makeDeclutter(),
    reviewItems: [],
    imageUrl: "blob:mock-preview",
    setDecisionOverride: vi.fn(),
    setItemExcluded: vi.fn(),
    confirm: vi.fn(),
    confirmationStatus: "idle",
    confirmationError: null,
    confirmation: null,
    ...overrides,
  };
}

function ddFor(labelText) {
  return screen.getByText(labelText).closest("div").querySelector("dd").textContent;
}

describe("DeclutterReview", () => {
  test("analysis summary renders scene and item counts", () => {
    const props = baseProps({
      analysis: makeAnalysis({ items: [{}, {}, {}] }),
      declutter: makeDeclutter({ expected_item_ids: ["item_001", "item_002"] }),
    });
    render(<DeclutterReview {...props} />);

    expect(ddFor("Scene")).toMatch(/bedroom/i);
    expect(ddFor("Candidate detections")).toBe("3");
    expect(ddFor("Candidates sent for suggestions")).toBe("2");
  });

  test("shows the detection-limitation guidance near the analysed image", () => {
    render(<DeclutterReview {...baseProps()} />);
    expect(screen.getByText(/ai detection may miss or misidentify belongings/i)).toBeInTheDocument();
  });

  test("two same-label items render as two distinct cards using item_id", async () => {
    const user = userEvent.setup();
    const setDecisionOverride = vi.fn();
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_004", clean_label: "picture frame", review_decision: "discard" }),
      makeResolvedReviewItem({ item_id: "item_006", clean_label: "picture frame", review_decision: "donate" }),
    ];
    const props = baseProps({
      analysis: makeAnalysis({ items: [{}, {}] }),
      declutter: makeDeclutter({ expected_item_ids: ["item_004", "item_006"] }),
      reviewItems,
      setDecisionOverride,
    });
    render(<DeclutterReview {...props} />);

    expect(screen.getAllByText("picture frame")).toHaveLength(2);
    const keepRadios = screen.getAllByRole("radio", { name: "Keep" });
    expect(keepRadios).toHaveLength(2);

    await user.click(keepRadios[0]);
    expect(setDecisionOverride).toHaveBeenCalledWith("item_004", "keep");
  });

  test("contextual items render with no decision controls", () => {
    const contextualItem = {
      item_id: "item_099",
      clean_label: "wall",
      position: "center",
      relative_size: "large",
      confidence: 0.9,
      box: { x1: 0.0, y1: 0.0, x2: 1.0, y2: 1.0 },
      ai_decision: null,
      ai_reason: null,
      item_validity: null,
      is_expected: false,
      is_unresolved: false,
      review_decision: null,
      review_excluded: false,
      review_user_reason: null,
      decision_changed: false,
      has_decision_override: false,
    };
    const props = baseProps({
      analysis: makeAnalysis({ items: [{}] }),
      declutter: makeDeclutter({ expected_item_ids: [] }),
      reviewItems: [contextualItem],
    });
    render(<DeclutterReview {...props} />);

    expect(screen.getByText("wall")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText(/detected for context only/i)).toBeInTheDocument();
  });

  test("unresolved items remain visible and block confirmation", () => {
    const unresolvedItem = {
      item_id: "item_003",
      clean_label: "cable",
      position: "center",
      relative_size: "small",
      confidence: 0.5,
      box: { x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.4 },
      ai_decision: null,
      ai_reason: null,
      item_validity: "still_invalid",
      is_expected: true,
      is_unresolved: true,
      review_decision: null,
      review_excluded: false,
      review_user_reason: null,
      decision_changed: false,
      has_decision_override: false,
    };
    const props = baseProps({
      analysis: makeAnalysis({ items: [{}] }),
      declutter: makeDeclutter({ expected_item_ids: ["item_003"], unresolved_item_ids: ["item_003"] }),
      reviewItems: [unresolvedItem],
    });
    render(<DeclutterReview {...props} />);

    expect(screen.getByText("cable")).toBeInTheDocument();
    expect(screen.getByText(/no valid ai decision was produced/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeDisabled();
  });

  test("clicking confirm calls confirm()", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    render(<DeclutterReview {...baseProps({ confirm })} />);

    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));

    expect(confirm).toHaveBeenCalled();
  });

  test("confirming status disables the confirm button", () => {
    render(<DeclutterReview {...baseProps({ confirmationStatus: "confirming" })} />);
    expect(screen.getByRole("button", { name: /confirming/i })).toBeDisabled();
  });

  test("confirmation failure shows an alert and preserves the review list", () => {
    const reviewItems = [makeResolvedReviewItem()];
    const props = baseProps({
      analysis: makeAnalysis({ items: [{}] }),
      declutter: makeDeclutter({ expected_item_ids: ["item_001"] }),
      reviewItems,
      confirmationStatus: "error",
      confirmationError: "Decision confirmation failed",
    });
    render(<DeclutterReview {...props} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/decision confirmation failed/i);
    expect(screen.getByText("lamp")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Keep" })).toBeInTheDocument();
  });

  test("confirmation summary disappears once confirmation becomes null (stale result invalidated)", () => {
    const confirmation = {
      runId: "run1",
      confirmedDecisions: [],
      confirmedKeepIds: [],
      decisionChangedCount: 0,
      excludedCount: 0,
      response: {},
    };
    const { rerender } = render(<DeclutterReview {...baseProps({ confirmationStatus: "confirmed", confirmation })} />);
    expect(screen.getByRole("heading", { name: /decisions confirmed/i })).toBeInTheDocument();

    rerender(<DeclutterReview {...baseProps({ confirmationStatus: "idle", confirmation: null })} />);

    expect(screen.queryByRole("heading", { name: /decisions confirmed/i })).not.toBeInTheDocument();
  });

  test("hovering an item card highlights its box in the analysed-room panel", async () => {
    const user = userEvent.setup();
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_004", clean_label: "picture frame" }),
      makeResolvedReviewItem({ item_id: "item_006", clean_label: "picture frame" }),
    ];
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: ["item_004", "item_006"] }),
      reviewItems,
    });
    render(<DeclutterReview {...props} />);

    // All boxes are visible by default, so both are already on the page.
    const cards = screen.getAllByText("picture frame").map((el) => el.closest("li"));
    await user.hover(cards[0]);

    expect(screen.getByRole("button", { name: /detection 4/i })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /detection 6/i })).not.toHaveAttribute("aria-current");
  });

  test("clicking a box scrolls to and focuses the corresponding item card", async () => {
    const user = userEvent.setup();
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_004", clean_label: "picture frame" }),
      makeResolvedReviewItem({ item_id: "item_006", clean_label: "vase" }),
    ];
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: ["item_004", "item_006"] }),
      reviewItems,
    });
    render(<DeclutterReview {...props} />);

    await user.click(screen.getByRole("button", { name: /detection 6/i }));

    const vaseCard = screen.getByText("vase").closest("li");
    expect(vaseCard).toHaveFocus();
  });

  test("Show all boxes is on by default, so every candidate detection's box is already visible", () => {
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_001", clean_label: "lamp" }),
      makeResolvedReviewItem({ item_id: "item_002", clean_label: "chair" }),
    ];
    render(
      <DeclutterReview {...baseProps({ declutter: makeDeclutter({ expected_item_ids: ["item_001", "item_002"] }), reviewItems })} />
    );

    expect(screen.getByRole("checkbox", { name: /show all boxes/i })).toBeChecked();
    expect(screen.getByRole("button", { name: /detection 1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /detection 2/i })).toBeInTheDocument();
  });

  test("turning Show all boxes off hides the boxes without hiding any item from the list", async () => {
    const user = userEvent.setup();
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_001", clean_label: "lamp" }),
      makeResolvedReviewItem({ item_id: "item_002", clean_label: "chair" }),
    ];
    render(
      <DeclutterReview {...baseProps({ declutter: makeDeclutter({ expected_item_ids: ["item_001", "item_002"] }), reviewItems })} />
    );

    await user.click(screen.getByRole("checkbox", { name: /show all boxes/i })); // was checked -> unchecks it

    expect(screen.getByRole("checkbox", { name: /show all boxes/i })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: /detection 1/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /detection 2/i })).not.toBeInTheDocument();
    // Neither item disappeared from the item list itself.
    expect(screen.getByText("lamp")).toBeInTheDocument();
    expect(screen.getByText("chair")).toBeInTheDocument();
  });

  test("with Show all boxes off, activating an item still shows just its own box", async () => {
    const user = userEvent.setup();
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_001", clean_label: "lamp" }),
      makeResolvedReviewItem({ item_id: "item_002", clean_label: "chair" }),
    ];
    render(
      <DeclutterReview {...baseProps({ declutter: makeDeclutter({ expected_item_ids: ["item_001", "item_002"] }), reviewItems })} />
    );

    await user.click(screen.getByRole("checkbox", { name: /show all boxes/i })); // turn all-boxes off
    expect(screen.queryAllByRole("button", { name: /^Detection/i })).toHaveLength(0);

    await user.hover(screen.getByText("chair").closest("li"));

    const boxes = screen.getAllByRole("button", { name: /^Detection/i });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toHaveAttribute("aria-label", expect.stringContaining("Detection 2"));
    expect(boxes[0]).toHaveAttribute("aria-current", "true");
  });

  test("unresolved and contextual entries can also become the active/highlighted item", async () => {
    const user = userEvent.setup();
    const unresolvedItem = {
      item_id: "item_003",
      clean_label: "cable",
      position: "center",
      relative_size: "small",
      confidence: 0.5,
      box: { x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.4 },
      ai_decision: null,
      ai_reason: null,
      item_validity: "still_invalid",
      is_expected: true,
      is_unresolved: true,
      review_decision: null,
      review_excluded: false,
      review_user_reason: null,
      decision_changed: false,
      has_decision_override: false,
    };
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: ["item_003"], unresolved_item_ids: ["item_003"] }),
      reviewItems: [unresolvedItem],
    });
    render(<DeclutterReview {...props} />);

    await user.hover(screen.getByText("cable").closest("li"));

    expect(screen.getByRole("button", { name: /detection 3/i })).toHaveAttribute("aria-current", "true");
  });

  test("responsive structure: both the analysed image and the full item list are always present in the DOM", () => {
    const reviewItems = [makeResolvedReviewItem({ item_id: "item_001" })];
    render(<DeclutterReview {...baseProps({ declutter: makeDeclutter({ expected_item_ids: ["item_001"] }), reviewItems })} />);

    // No JS media-query branching hides either side, layout is CSS-only
    // (flex-col on mobile, lg:flex-row on desktop), so both the image and
    // the item list exist in the DOM regardless of viewport.
    expect(screen.getByRole("img", { name: /detected item outlines/i })).toBeInTheDocument();
    expect(screen.getByText("lamp")).toBeInTheDocument();
  });

  test("an unresolved item's correction control works and reaches correctLabel", async () => {
    const user = userEvent.setup();
    const correctLabel = vi.fn();
    const unresolvedItem = {
      item_id: "item_003",
      clean_label: "cable",
      position: "center",
      relative_size: "small",
      confidence: 0.5,
      box: { x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.4 },
      ai_decision: null,
      ai_reason: null,
      item_validity: "still_invalid",
      is_expected: true,
      is_unresolved: true,
      review_decision: null,
      review_excluded: false,
      review_user_reason: null,
      decision_changed: false,
      has_decision_override: false,
      corrected_label: null,
      label_source: "detector",
      effective_label: "cable",
    };
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: ["item_003"], unresolved_item_ids: ["item_003"] }),
      reviewItems: [unresolvedItem],
      correctLabel,
    });
    render(<DeclutterReview {...props} />);

    await user.click(screen.getByRole("button", { name: /wrong label/i }));
    const input = screen.getByLabelText(/corrected label/i);
    await user.clear(input);
    await user.type(input, "charger");
    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(correctLabel).toHaveBeenCalledWith("item_003", "charger");
  });

  test("a corrected but still-unresolved item preserves its corrected label and stays visibly unresolved", () => {
    const unresolvedItem = {
      item_id: "item_003",
      clean_label: "cable",
      position: "center",
      relative_size: "small",
      confidence: 0.5,
      box: { x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.4 },
      ai_decision: null,
      ai_reason: null,
      item_validity: "still_invalid",
      is_expected: true,
      is_unresolved: true,
      review_decision: null,
      review_excluded: false,
      review_user_reason: null,
      decision_changed: false,
      has_decision_override: false,
      corrected_label: "charger",
      label_source: "user",
      effective_label: "charger",
    };
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: ["item_003"], unresolved_item_ids: ["item_003"] }),
      reviewItems: [unresolvedItem],
    });
    render(<DeclutterReview {...props} />);

    expect(screen.getByText("charger")).toBeInTheDocument();
    expect(screen.queryByText("cable")).not.toBeInTheDocument();
    expect(screen.getByText("Corrected by you")).toBeInTheDocument();
    expect(screen.getByText(/no valid ai decision was produced/i)).toBeInTheDocument();
  });

  test("contextual items display effective_label but offer no correction control", () => {
    const contextualItem = {
      item_id: "item_099",
      clean_label: "wall",
      position: "center",
      relative_size: "large",
      confidence: 0.9,
      box: { x1: 0.0, y1: 0.0, x2: 1.0, y2: 1.0 },
      ai_decision: null,
      ai_reason: null,
      item_validity: null,
      is_expected: false,
      is_unresolved: false,
      review_decision: null,
      review_excluded: false,
      review_user_reason: null,
      decision_changed: false,
      has_decision_override: false,
      corrected_label: null,
      label_source: "detector",
      effective_label: "wall",
    };
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: [] }),
      reviewItems: [contextualItem],
    });
    render(<DeclutterReview {...props} />);

    expect(screen.getByText("wall")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /wrong label/i })).not.toBeInTheDocument();
  });

  test("confirmation is disabled while a correction is in flight", () => {
    const reviewItems = [makeResolvedReviewItem({ item_id: "item_001" })];
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: ["item_001"] }),
      reviewItems,
      correctingItemId: "item_001",
    });
    render(<DeclutterReview {...props} />);

    expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeDisabled();
  });

  test("every correction control is disabled while any single correction is in flight", () => {
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_001", clean_label: "lamp" }),
      makeResolvedReviewItem({ item_id: "item_002", clean_label: "chair" }),
    ];
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: ["item_001", "item_002"] }),
      reviewItems,
      correctingItemId: "item_001",
    });
    render(<DeclutterReview {...props} />);

    const wrongLabelButtons = screen.getAllByRole("button", { name: /wrong label|correcting/i });
    expect(wrongLabelButtons.length).toBeGreaterThan(0);
    wrongLabelButtons.forEach((button) => expect(button).toBeDisabled());
  });

  test("a correction error only appears next to the item it belongs to", async () => {
    const user = userEvent.setup();
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_001", clean_label: "lamp" }),
      makeResolvedReviewItem({ item_id: "item_002", clean_label: "chair" }),
    ];
    const props = baseProps({
      declutter: makeDeclutter({ expected_item_ids: ["item_001", "item_002"] }),
      reviewItems,
      correctionError: { itemId: "item_001", message: "Label correction failed" },
    });
    render(<DeclutterReview {...props} />);

    const wrongLabelButtons = screen.getAllByRole("button", { name: /wrong label/i });
    for (const button of wrongLabelButtons) {
      await user.click(button); // open every card's correction form
    }

    expect(screen.getAllByRole("alert")).toHaveLength(1); // only item_001's form shows the error
    expect(screen.getByRole("alert")).toHaveTextContent("Label correction failed");
  });
});

describe("DeclutterReview, confirmation handoff copy", () => {
  function makeConfirmation() {
    return {
      runId: "run1",
      confirmedDecisions: [
        {
          item_id: "item_001",
          ai_decision: "keep",
          confirmed_decision: "keep",
          ai_reason: "still useful",
          user_reason: null,
          excluded: false,
          decision_changed: false,
        },
      ],
      confirmedKeepIds: ["item_001"],
      decisionChangedCount: 0,
      excludedCount: 0,
      response: {},
    };
  }

  test("without the prop, ConfirmationSummary's own default wording is shown unchanged", () => {
    const props = baseProps({ confirmation: makeConfirmation() });
    render(<DeclutterReview {...props} />);
    expect(screen.getByText(/future reorganise stage/i)).toBeInTheDocument();
  });

  test("a configured confirmationNextStepNote is forwarded to ConfirmationSummary", () => {
    const props = baseProps({
      confirmation: makeConfirmation(),
      confirmationNextStepNote: "These confirmed Keep items will be sent to reorganisation next.",
    });
    render(<DeclutterReview {...props} />);
    expect(screen.getByText(/sent to reorganisation next/i)).toBeInTheDocument();
    expect(screen.queryByText(/future reorganise stage/i)).not.toBeInTheDocument();
  });
});

describe("DeclutterReview, review page layout and presentation", () => {
  test("shows a results header, a change-before-confirm explainer and a restrained You're in control notice", () => {
    render(<DeclutterReview {...baseProps()} />);
    expect(screen.getByRole("heading", { name: /review your declutter decisions/i })).toBeInTheDocument();
    expect(screen.getByText(/yours to change, exclude or correct/i)).toBeInTheDocument();
    expect(screen.getByText(/you're in control/i)).toBeInTheDocument();
  });

  test("does not add a universal workflow stepper", () => {
    render(<DeclutterReview {...baseProps()} />);
    expect(screen.queryByRole("navigation", { name: /progress|steps?/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/step \d+ of \d+/i)).not.toBeInTheDocument();
  });

  test("keeps the analysed image and the item list both in the DOM, side-by-side on desktop", () => {
    const reviewItems = [makeResolvedReviewItem({ item_id: "item_001" })];
    const { container } = render(
      <DeclutterReview {...baseProps({ declutter: makeDeclutter({ expected_item_ids: ["item_001"] }), reviewItems })} />
    );
    expect(screen.getByRole("img", { name: /detected item outlines/i })).toBeInTheDocument();
    expect(screen.getByText("lamp")).toBeInTheDocument();
    // CSS-only responsive split, column on mobile, row from lg up.
    const split = container.querySelector(".lg\\:flex-row");
    expect(split).toBeTruthy();
    expect(split.className).toMatch(/(^|\s)flex-col(\s|$)/);
  });

  test("the confirm button exposes a visible keyboard focus ring", () => {
    render(<DeclutterReview {...baseProps()} />);
    const btn = screen.getByRole("button", { name: /confirm decisions/i });
    btn.focus();
    expect(btn).toHaveFocus();
    expect(btn.className).toMatch(/focus-visible:ring/);
  });

  test("only one full-size analysed-room image is rendered; per-item crops are decorative", () => {
    const reviewItems = [
      makeResolvedReviewItem({ item_id: "item_001", clean_label: "lamp" }),
      makeResolvedReviewItem({ item_id: "item_002", clean_label: "chair" }),
    ];
    render(
      <DeclutterReview {...baseProps({ declutter: makeDeclutter({ expected_item_ids: ["item_001", "item_002"] }), reviewItems })} />
    );
    // The only element with an image role is the single analysed-room photo.
    expect(screen.getAllByRole("img")).toHaveLength(1);
    // The compact rows still carry decorative CSS crops derived from it.
    expect(screen.getAllByTestId("item-crop-thumbnail").length).toBe(2);
  });
});
