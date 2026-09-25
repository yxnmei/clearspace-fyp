import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterResultsSummary, { countConfirmed } from "./DeclutterResultsSummary";

const reviewItems = [
  { item_id: "item_001", effective_label: "lamp", box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } },
  { item_id: "item_002", effective_label: "shelf", box: { x1: 0.2, y1: 0.1, x2: 0.3, y2: 0.2 } },
  { item_id: "item_003", effective_label: "toy", box: { x1: 0.3, y1: 0.1, x2: 0.4, y2: 0.2 } },
  { item_id: "item_004", effective_label: "box", box: { x1: 0.4, y1: 0.1, x2: 0.5, y2: 0.2 } },
  { item_id: "item_005", effective_label: "chair", box: { x1: 0.5, y1: 0.1, x2: 0.6, y2: 0.2 } },
];

function decision(overrides) {
  return {
    item_id: "item_001",
    ai_decision: "keep",
    confirmed_decision: "keep",
    ai_reason: "still in use",
    user_reason: null,
    excluded: false,
    decision_changed: false,
    ...overrides,
  };
}

const confirmation = {
  runId: "run1",
  confirmedDecisions: [
    decision({ item_id: "item_001" }),
    decision({ item_id: "item_002" }),
    decision({ item_id: "item_003", ai_decision: "donate", confirmed_decision: "donate" }),
    decision({ item_id: "item_004", ai_decision: "discard", confirmed_decision: "discard", excluded: true }),
    decision({ item_id: "item_005", ai_decision: "keep", confirmed_decision: "sell", decision_changed: true }),
  ],
  confirmedKeepIds: ["item_001", "item_002"],
  decisionChangedCount: 1,
  excludedCount: 1,
};

describe("DeclutterResultsSummary", () => {
  test("shows the completion heading, four count cards in a fixed order (zeros included) and the excluded note", () => {
    render(<DeclutterResultsSummary confirmation={confirmation} reviewItems={reviewItems} imageUrl="blob:test" />);
    const region = screen.getByRole("region", { name: "Declutter complete" });
    expect(within(region).getByText("Your decisions are confirmed. Here's your final summary.")).toBeInTheDocument();
    const counts = within(region).getByLabelText("Confirmed decision counts");
    expect(within(counts).getAllByRole("term").map((dt) => dt.textContent)).toEqual(["Keep", "Sell", "Donate", "Discard"]);
    expect(within(counts).getAllByRole("definition").map((dd) => dd.textContent)).toEqual(["2", "1", "1", "0"]);
    expect(within(region).getByText(/1 item excluded from later steps/i)).toBeInTheDocument();
    expect(region.textContent).not.toMatch(/item_00|still in use|locked in/);
  });

  test("the confirmed items are collapsed by default and expand into the shared chip summary, read-only", async () => {
    const user = userEvent.setup();
    render(<DeclutterResultsSummary confirmation={confirmation} reviewItems={reviewItems} imageUrl="blob:test" />);
    expect(screen.getByText(/your confirmed items/i)).toHaveTextContent("(5)");
    const view = screen.getByRole("button", { name: "View items" });
    expect(view).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Confirmed items")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy summary" })).not.toBeInTheDocument();

    await user.click(view);
    const hide = screen.getByRole("button", { name: "Hide items" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(hide.getAttribute("aria-controls"))).not.toHaveAttribute("hidden");
    const summary = screen.getByLabelText("Confirmed items");
    expect(within(summary).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Keep", "Sell", "Donate", "Excluded"]);
    expect(within(summary).getAllByRole("listitem")).toHaveLength(5);
    expect(within(summary).queryByRole("button", { name: /^Edit .* decisions$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy summary" })).toBeInTheDocument();

    // A chip still opens the photo with that item outlined.
    await user.click(within(summary).getByRole("button", { name: "Show chair in the photo" }));
    expect(screen.getByRole("dialog", { name: "chair in your photo" })).toBeInTheDocument();
    expect(screen.getAllByTestId("lightbox-overlay")).toHaveLength(1);
    await user.keyboard("{Escape}");

    await user.click(hide);
    expect(screen.queryByLabelText("Confirmed items")).not.toBeInTheDocument();
  });

  test("Edit decisions calls back and is absent without a handler; heading and intro can be overridden", async () => {
    const user = userEvent.setup();
    const onEditDecisions = vi.fn();
    const { rerender } = render(
      <DeclutterResultsSummary confirmation={confirmation} reviewItems={reviewItems} onEditDecisions={onEditDecisions} />
    );
    await user.click(screen.getByRole("button", { name: "Edit decisions" }));
    expect(onEditDecisions).toHaveBeenCalledTimes(1);

    rerender(
      <DeclutterResultsSummary
        confirmation={confirmation}
        reviewItems={reviewItems}
        heading="Declutter summary"
        intro="Tidy up uses what you kept."
      />
    );
    expect(screen.getByRole("region", { name: "Declutter summary" })).toBeInTheDocument();
    expect(screen.getByText("Tidy up uses what you kept.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit decisions" })).not.toBeInTheDocument();
  });

  test("countConfirmed counts non-excluded decisions by final category and excluded once", () => {
    expect(countConfirmed(confirmation)).toEqual({ keep: 2, sell: 1, donate: 1, discard: 0, excluded: 1 });
  });

  test("rendered copy contains no em dash", () => {
    const { container } = render(<DeclutterResultsSummary confirmation={confirmation} reviewItems={reviewItems} />);
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
