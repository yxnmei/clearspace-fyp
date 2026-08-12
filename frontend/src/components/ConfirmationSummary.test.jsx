import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import ConfirmationSummary from "./ConfirmationSummary";

function makeConfirmedDecision(overrides = {}) {
  return {
    item_id: "item_001",
    ai_decision: "keep",
    confirmed_decision: "keep",
    ai_reason: "still useful",
    user_reason: null,
    excluded: false,
    decision_changed: false,
    ...overrides,
  };
}

function ddFor(labelText) {
  return screen.getByText(labelText).closest("div").querySelector("dd").textContent;
}

describe("ConfirmationSummary", () => {
  test("successful confirmation shows final counts", () => {
    const confirmation = {
      runId: "run1",
      confirmedDecisions: [
        makeConfirmedDecision({ item_id: "item_001", confirmed_decision: "keep" }),
        makeConfirmedDecision({
          item_id: "item_002",
          ai_decision: "keep",
          confirmed_decision: "donate",
          decision_changed: true,
        }),
      ],
      confirmedKeepIds: ["item_001"],
      decisionChangedCount: 1,
      excludedCount: 0,
      response: {},
    };

    render(<ConfirmationSummary confirmation={confirmation} reviewItems={[]} />);

    expect(screen.getByRole("heading", { name: /decisions confirmed/i })).toBeInTheDocument();
    expect(ddFor("Keep")).toBe("1");
    expect(ddFor("Donate")).toBe("1");
    expect(ddFor("Sell")).toBe("0");
    expect(ddFor("Discard")).toBe("0");
    expect(ddFor("Changed from AI")).toBe("1");
    expect(ddFor("Excluded")).toBe("0");
  });

  test("confirmed Keep IDs are matched to review items by item_id, not label", () => {
    const confirmation = {
      runId: "run1",
      confirmedDecisions: [
        makeConfirmedDecision({ item_id: "item_004" }),
        makeConfirmedDecision({ item_id: "item_006" }),
      ],
      confirmedKeepIds: ["item_004", "item_006"],
      decisionChangedCount: 0,
      excludedCount: 0,
      response: {},
    };
    // Both share a label — matching must go by item_id, not clean_label.
    const reviewItems = [
      { item_id: "item_004", clean_label: "picture frame", position: "upper-left" },
      { item_id: "item_006", clean_label: "picture frame", position: "left" },
    ];

    render(<ConfirmationSummary confirmation={confirmation} reviewItems={reviewItems} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("item_004");
    expect(items[0]).toHaveTextContent("upper-left");
    expect(items[1]).toHaveTextContent("item_006");
    expect(items[1]).toHaveTextContent(/\(left\)/);
  });

  test("shows a message when no items were confirmed as Keep", () => {
    const confirmation = {
      runId: "run1",
      confirmedDecisions: [makeConfirmedDecision({ confirmed_decision: "discard" })],
      confirmedKeepIds: [],
      decisionChangedCount: 0,
      excludedCount: 0,
      response: {},
    };
    render(<ConfirmationSummary confirmation={confirmation} reviewItems={[]} />);
    expect(screen.getByText(/no items were confirmed as keep/i)).toBeInTheDocument();
  });
});
