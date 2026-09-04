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
    // Both share a label, matching must go by item_id, not clean_label.
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

  test("a corrected Keep item's summary entry shows effective_label, not clean_label", () => {
    const confirmation = {
      runId: "run1",
      confirmedDecisions: [makeConfirmedDecision({ item_id: "item_001" })],
      confirmedKeepIds: ["item_001"],
      decisionChangedCount: 0,
      excludedCount: 0,
      response: {},
    };
    const reviewItems = [
      { item_id: "item_001", clean_label: "box", corrected_label: "hoodie", effective_label: "hoodie", position: "left" },
    ];

    render(<ConfirmationSummary confirmation={confirmation} reviewItems={reviewItems} />);

    const entry = screen.getAllByRole("listitem")[0];
    expect(entry).toHaveTextContent("hoodie");
    expect(entry).not.toHaveTextContent("box");
  });

  test("an uncorrected Keep item's summary entry falls back to clean_label", () => {
    const confirmation = {
      runId: "run1",
      confirmedDecisions: [makeConfirmedDecision({ item_id: "item_001" })],
      confirmedKeepIds: ["item_001"],
      decisionChangedCount: 0,
      excludedCount: 0,
      response: {},
    };
    const reviewItems = [{ item_id: "item_001", clean_label: "lamp", position: "left" }];

    render(<ConfirmationSummary confirmation={confirmation} reviewItems={reviewItems} />);

    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("lamp");
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

  test("without nextStepNote, the standalone-Declutter wording is shown and promises no Reorganise stage", () => {
    const confirmation = {
      runId: "run1",
      confirmedDecisions: [makeConfirmedDecision()],
      confirmedKeepIds: ["item_001"],
      decisionChangedCount: 0,
      excludedCount: 0,
      response: {},
    };
    render(<ConfirmationSummary confirmation={confirmation} reviewItems={[]} />);
    expect(screen.getByText(/these are the items you confirmed to keep/i)).toBeInTheDocument();
    expect(screen.queryByText(/reorganise/i)).not.toBeInTheDocument();
  });

  test("a configured nextStepNote replaces the default wording (Both)", () => {
    const confirmation = {
      runId: "run1",
      confirmedDecisions: [makeConfirmedDecision()],
      confirmedKeepIds: ["item_001"],
      decisionChangedCount: 0,
      excludedCount: 0,
      response: {},
    };
    render(
      <ConfirmationSummary
        confirmation={confirmation}
        reviewItems={[]}
        nextStepNote="These confirmed Keep items will be sent to reorganisation next."
      />
    );
    expect(screen.getByText(/sent to reorganisation next/i)).toBeInTheDocument();
    expect(screen.queryByText(/these are the items you confirmed to keep/i)).not.toBeInTheDocument();
  });

  test("success-toned panel keeps the run status line and every count / evidence field", () => {
    const confirmation = {
      runId: "run7",
      confirmedDecisions: [
        makeConfirmedDecision({ item_id: "item_001", confirmed_decision: "keep" }),
        makeConfirmedDecision({ item_id: "item_002", confirmed_decision: "discard", decision_changed: true }),
      ],
      confirmedKeepIds: ["item_001"],
      decisionChangedCount: 1,
      excludedCount: 2,
      response: {},
    };
    const { container } = render(
      <ConfirmationSummary
        confirmation={confirmation}
        reviewItems={[{ item_id: "item_001", clean_label: "lamp", position: "left" }]}
      />
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/run run7, 2 decisions confirmed/i);
    expect(ddFor("Keep")).toBe("1");
    expect(ddFor("Discard")).toBe("1");
    expect(ddFor("Changed from AI")).toBe("1");
    expect(ddFor("Excluded")).toBe("2");
    expect(screen.getByRole("heading", { name: /decisions confirmed/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /confirmed keep items \(1\)/i })).toBeInTheDocument();
    expect(container.querySelector("section").className).toMatch(/border-success/);
  });
});
