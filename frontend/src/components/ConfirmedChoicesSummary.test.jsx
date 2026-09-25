import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ConfirmedChoicesSummary, { copySummaryText, summaryRows } from "./ConfirmedChoicesSummary";

const reviewItems = [
  { item_id: "item_001", effective_label: "lamp", box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } },
  { item_id: "item_002", effective_label: "shelf", box: { x1: 0.2, y1: 0.1, x2: 0.3, y2: 0.2 } },
  { item_id: "item_003", effective_label: "shelf", box: { x1: 0.3, y1: 0.1, x2: 0.4, y2: 0.2 } },
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
    decision({ item_id: "item_003" }),
    decision({ item_id: "item_004", ai_decision: "discard", confirmed_decision: "discard", excluded: true }),
    decision({ item_id: "item_005", ai_decision: "keep", confirmed_decision: "sell", decision_changed: true }),
  ],
  confirmedKeepIds: ["item_001", "item_002", "item_003"],
  decisionChangedCount: 1,
  excludedCount: 1,
};

describe("ConfirmedChoicesSummary", () => {
  test("renders each group as a wrapping list of chips, one chip per item_id", () => {
    render(<ConfirmedChoicesSummary confirmation={confirmation} reviewItems={reviewItems} imageUrl="blob:test" />);
    const summary = screen.getByLabelText("Confirmed choices summary");
    expect(within(summary).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Keep", "Sell", "Excluded"]);
    const keep = within(summary).getByRole("list", { name: "Keep items" });
    expect(keep.className).toMatch(/flex-wrap/);
    const chips = within(keep).getAllByRole("listitem");
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.textContent)).toEqual(["lamp", "shelf", "shelf"]);
    for (const chip of chips) expect(within(chip).getByRole("button").className).toMatch(/rounded-pill/);
    expect(summary.textContent).not.toMatch(/item_00|still in use/);
    expect(screen.queryByRole("button", { name: /^Edit .* decisions$/ })).not.toBeInTheDocument();
  });

  test("a chip opens the photo in the lightbox with only that item outlined and highlighted", async () => {
    const user = userEvent.setup();
    render(<ConfirmedChoicesSummary confirmation={confirmation} reviewItems={reviewItems} imageUrl="blob:test" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const keep = screen.getByRole("list", { name: "Keep items" });
    const secondShelf = within(keep).getAllByRole("button", { name: "Show shelf in the photo" })[1];
    await user.click(secondShelf);
    const dialog = screen.getByRole("dialog", { name: "shelf in your photo" });
    expect(dialog).toHaveAccessibleDescription(/only this item's outline is shown/i);
    expect(within(dialog).getByRole("img", { name: "The space photo you uploaded" })).toHaveAttribute("src", "blob:test");
    const outlines = within(dialog).getAllByTestId("lightbox-overlay");
    expect(outlines).toHaveLength(1);
    // item_003's box, not item_002's: identity is item_id even with the same label
    expect(outlines[0].style.left).toBe("30%");
    expect(outlines[0].className).toMatch(/ring-2/);
    expect(within(dialog).getByRole("checkbox", { name: "Show boxes" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(secondShelf).toHaveFocus();
  });

  test("chips are inert without an image, and Edit links call back with the group's filter", async () => {
    const user = userEvent.setup();
    const onEditCategory = vi.fn();
    render(<ConfirmedChoicesSummary confirmation={confirmation} reviewItems={reviewItems} imageUrl={null} onEditCategory={onEditCategory} />);
    expect(screen.getByRole("button", { name: "Show lamp in the photo" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Edit Keep decisions" }));
    await user.click(screen.getByRole("button", { name: "Edit Excluded decisions" }));
    expect(onEditCategory.mock.calls).toEqual([["keep"], ["all"]]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("a changed decision is marked with an accessible word, not colour alone", () => {
    render(<ConfirmedChoicesSummary confirmation={confirmation} reviewItems={reviewItems} />);
    const sell = screen.getByRole("list", { name: "Sell items" });
    const chair = within(sell).getByRole("listitem");
    expect(chair).toHaveTextContent("chair");
    expect(within(chair).getByText("Changed")).toHaveClass("sr-only");
    const keep = screen.getByRole("list", { name: "Keep items" });
    expect(within(keep).queryByText("Changed")).not.toBeInTheDocument();
  });

  test("copy text counts repeated labels as label (n) and the write happens inside the click", async () => {
    const user = userEvent.setup();
    const writer = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmedChoicesSummary confirmation={confirmation} reviewItems={reviewItems} clipboardWriter={writer} />);
    await user.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writer).toHaveBeenCalledWith("Keep: lamp, shelf (2)\nSell: chair\nExcluded: box");
    expect(await screen.findByText("Summary copied to your clipboard.")).toBeInTheDocument();
  });

  test("a failed copy shows the generic message and changes nothing", async () => {
    const user = userEvent.setup();
    const writer = vi.fn().mockRejectedValue(new Error("NotAllowedError: secret detail"));
    render(<ConfirmedChoicesSummary confirmation={confirmation} reviewItems={reviewItems} clipboardWriter={writer} />);
    await user.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(await screen.findByText("Could not copy the summary. Nothing has changed.")).toBeInTheDocument();
    expect(screen.queryByText(/secret detail/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  test("pure helpers: rows join by item_id and the copy text has one line per group", () => {
    const rows = summaryRows(confirmation, reviewItems);
    expect(rows.map((group) => group.title)).toEqual(["Keep", "Sell", "Excluded"]);
    expect(rows[0].entries.map((entry) => entry.decision.item_id)).toEqual(["item_001", "item_002", "item_003"]);
    expect(copySummaryText(rows)).toBe("Keep: lamp, shelf (2)\nSell: chair\nExcluded: box");
  });

  test("rendered copy contains no em dash", () => {
    const { container } = render(<ConfirmedChoicesSummary confirmation={confirmation} reviewItems={reviewItems} />);
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });

  test("chips, copy text and the lightbox title use the user-facing display_label, joined by item_id", async () => {
    const user = userEvent.setup();
    const writer = vi.fn().mockResolvedValue(undefined);
    const renamed = reviewItems.map((item) =>
      item.item_id === "item_003" ? { ...item, display_label: "Tall bookshelf" } : { ...item, display_label: item.effective_label }
    );
    render(<ConfirmedChoicesSummary confirmation={confirmation} reviewItems={renamed} imageUrl="blob:test" clipboardWriter={writer} />);
    const keep = screen.getByRole("list", { name: "Keep items" });
    expect(within(keep).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual(["lamp", "shelf", "Tall bookshelf"]);
    await user.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writer).toHaveBeenCalledWith("Keep: lamp, shelf, Tall bookshelf\nSell: chair\nExcluded: box");
    await user.click(screen.getByRole("button", { name: "Show Tall bookshelf in the photo" }));
    expect(screen.getByRole("dialog", { name: "Tall bookshelf in your photo" })).toBeInTheDocument();
  });
});
