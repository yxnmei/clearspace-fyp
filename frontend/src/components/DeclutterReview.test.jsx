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
  return {
    item_id: "item_001",
    raw_phrase: "lamp",
    clean_label: "lamp",
    position: "upper-left",
    relative_size: "small",
    confidence: 0.8,
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
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    analysis: makeAnalysis(),
    declutter: makeDeclutter(),
    reviewItems: [],
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
    expect(ddFor("Detected items")).toBe("3");
    expect(ddFor("Actionable items")).toBe("2");
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
});
