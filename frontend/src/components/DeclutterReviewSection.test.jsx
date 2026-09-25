import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterReviewSection from "./DeclutterReviewSection";

function resolvedItem(overrides = {}) {
  const clean = overrides.clean_label ?? "lamp";
  return {
    item_id: "item_001",
    clean_label: clean,
    effective_label: overrides.effective_label ?? clean,
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
    decision_changed: false,
    label_source: "detector",
    ...overrides,
  };
}

function unresolvedItem(overrides = {}) {
  return {
    ...resolvedItem(overrides),
    item_id: "item_003",
    clean_label: "cable",
    effective_label: "cable",
    is_unresolved: true,
    review_decision: null,
    ai_decision: null,
    ...overrides,
  };
}

function contextualItem(overrides = {}) {
  return {
    ...resolvedItem(overrides),
    item_id: "item_099",
    clean_label: "wall",
    effective_label: "wall",
    is_expected: false,
    review_decision: null,
    ai_decision: null,
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    reviewItems: [],
    imageUrl: "blob:mock-room",
    setDecisionOverride: vi.fn(),
    setItemExcluded: vi.fn(),
    correctLabel: vi.fn(),
    correctingItemId: null,
    correctionError: null,
    ...overrides,
  };
}

describe("DeclutterReviewSection", () => {
  test("shows the human-control header, one analysed-room image and no confirmation panel", () => {
    render(<DeclutterReviewSection {...baseProps({ reviewItems: [resolvedItem()] })} />);
    expect(screen.getByRole("heading", { name: /review your declutter decisions/i })).toBeInTheDocument();
    expect(screen.getByText(/you're in control/i)).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /confirm decisions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /decisions confirmed/i })).not.toBeInTheDocument();
  });

  test("partitions items into actionable rows, unresolved and contextual", () => {
    render(
      <DeclutterReviewSection
        {...baseProps({ reviewItems: [resolvedItem(), unresolvedItem(), contextualItem()] })}
      />
    );
    expect(screen.getByText("lamp")).toBeInTheDocument();
    expect(screen.getByText(/could not suggest an action for this item/i)).toBeInTheDocument();
    expect(screen.getByText(/detected for context only/i)).toBeInTheDocument();
    // contextual items get no decision radios
    const contextualRow = screen.getByText("wall").closest("li");
    expect(within(contextualRow).queryByRole("radio")).toBeNull();
  });

  test("duplicate-label rows stay independent by item_id", async () => {
    const user = userEvent.setup();
    const setDecisionOverride = vi.fn();
    render(
      <DeclutterReviewSection
        {...baseProps({
          reviewItems: [
            resolvedItem({ item_id: "item_004", clean_label: "picture frame", review_decision: "keep" }),
            resolvedItem({ item_id: "item_006", clean_label: "picture frame", review_decision: "discard" }),
          ],
          setDecisionOverride,
        })}
      />
    );
    const sellRadios = screen.getAllByRole("radio", { name: "Sell" });
    expect(sellRadios).toHaveLength(2);
    await user.click(sellRadios[1]);
    expect(setDecisionOverride).toHaveBeenCalledWith("item_006", "sell");
  });

  test("hovering a compact row marks the matching overlay box current", async () => {
    const user = userEvent.setup();
    render(
      <DeclutterReviewSection
        {...baseProps({
          reviewItems: [
            resolvedItem({ item_id: "item_001", clean_label: "lamp" }),
            resolvedItem({ item_id: "item_002", clean_label: "chair" }),
          ],
        })}
      />
    );
    await user.hover(screen.getByText("chair").closest("li"));
    expect(screen.getByRole("button", { name: /detection 2: chair/i })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /detection 1: lamp/i })).not.toHaveAttribute("aria-current");
  });

  test("Show all boxes stays on by default", () => {
    render(<DeclutterReviewSection {...baseProps({ reviewItems: [resolvedItem()] })} />);
    expect(screen.getByRole("checkbox", { name: /show all boxes/i })).toBeChecked();
  });
});

describe("DeclutterReviewSection, decision filters", () => {
  const rowsFixture = () => [
    resolvedItem({ item_id: "item_001", clean_label: "lamp", review_decision: "keep" }),
    resolvedItem({ item_id: "item_002", clean_label: "old chair", review_decision: "sell", ai_decision: "keep" }),
    resolvedItem({ item_id: "item_003", clean_label: "broken mug", review_decision: "discard", review_excluded: true }),
    resolvedItem({ item_id: "item_004", clean_label: "spare rug", review_decision: "donate" }),
  ];

  const filterGroup = () => screen.getByRole("group", { name: /filter items by decision/i });
  const chip = (name) => within(filterGroup()).getByRole("button", { name: new RegExp(`^${name}`, "i") });

  test("renders All + the four decision chips as toggle buttons, All pressed by default", () => {
    render(<DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture() })} />);
    for (const name of ["All", "Keep", "Sell", "Donate", "Discard"]) {
      expect(chip(name)).toHaveAttribute("aria-pressed");
    }
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
    expect(chip("Keep")).toHaveAttribute("aria-pressed", "false");
  });

  test("chip counts reflect current review_decision, including excluded items", () => {
    render(<DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture() })} />);
    expect(chip("All")).toHaveTextContent("4");
    expect(chip("Keep")).toHaveTextContent("1");
    expect(chip("Sell")).toHaveTextContent("1");
    expect(chip("Donate")).toHaveTextContent("1");
    expect(chip("Discard")).toHaveTextContent("1"); // the excluded mug still counts under Discard
  });

  test("selecting a decision chip narrows the list to items with that current decision", async () => {
    const user = userEvent.setup();
    render(<DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture() })} />);

    await user.click(chip("Sell"));
    expect(chip("Sell")).toHaveAttribute("aria-pressed", "true");
    expect(chip("All")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("old chair")).toBeInTheDocument();
    expect(screen.queryByText("lamp")).not.toBeInTheDocument();
    expect(screen.queryByText("spare rug")).not.toBeInTheDocument();
  });

  test("an excluded item is still shown under its decision filter", async () => {
    const user = userEvent.setup();
    render(<DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture() })} />);
    await user.click(chip("Discard"));
    expect(screen.getByText("broken mug")).toBeInTheDocument();
    expect(within(screen.getByText("broken mug").closest("li")).getByText(/excluded/i)).toBeInTheDocument();
  });

  test("a filterRequest from the page applies that filter, repeats via its nonce, and leaves the chips in the user's hands", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture(), filterRequest: { id: "sell", nonce: 1 } })} />
    );
    expect(chip("Sell")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("old chair")).toBeInTheDocument();
    expect(screen.queryByText("lamp")).not.toBeInTheDocument();

    // The user can still change it afterwards.
    await user.click(chip("All"));
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");

    // The same id requested again (new nonce) re-applies it.
    rerender(<DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture(), filterRequest: { id: "sell", nonce: 2 } })} />);
    expect(chip("Sell")).toHaveAttribute("aria-pressed", "true");

    // An unknown id falls back to All rather than an empty list.
    rerender(<DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture(), filterRequest: { id: "nonsense", nonce: 3 } })} />);
    expect(chip("All")).toHaveAttribute("aria-pressed", "true");
  });

  test("changing the props' review_decision moves the item between filters and updates counts", () => {
    const { rerender } = render(<DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture() })} />);
    expect(chip("Donate")).toHaveTextContent("1");

    const moved = rowsFixture().map((it) =>
      it.item_id === "item_001" ? { ...it, review_decision: "donate", decision_changed: true } : it
    );
    rerender(<DeclutterReviewSection {...baseProps({ reviewItems: moved })} />);
    expect(chip("Keep")).toHaveTextContent("0");
    expect(chip("Donate")).toHaveTextContent("2");
  });

  test("unresolved items stay visible under every filter (a blocker cannot be hidden)", async () => {
    const user = userEvent.setup();
    render(
      <DeclutterReviewSection
        {...baseProps({ reviewItems: [...rowsFixture(), unresolvedItem({ item_id: "item_050", clean_label: "mystery cable" })] })}
      />
    );
    await user.click(chip("Keep"));
    expect(screen.getByText(/could not suggest an action for this item/i)).toBeInTheDocument();
  });

  test("a decision filter with no matching items shows a concise empty state", async () => {
    const user = userEvent.setup();
    render(
      <DeclutterReviewSection
        {...baseProps({ reviewItems: [resolvedItem({ item_id: "item_001", review_decision: "keep" })] })}
      />
    );
    await user.click(chip("Sell"));
    expect(screen.getByText("No items currently marked as Sell.")).toBeInTheDocument();
  });

  test("filtered-out resolved rows leave no interactive overlay box behind", async () => {
    const user = userEvent.setup();
    render(
      <DeclutterReviewSection
        {...baseProps({
          reviewItems: [
            resolvedItem({ item_id: "item_001", clean_label: "lamp", review_decision: "keep" }),
            resolvedItem({ item_id: "item_002", clean_label: "old chair", review_decision: "sell" }),
          ],
        })}
      />
    );
    expect(screen.getByRole("button", { name: /detection .*: old chair/i })).toBeInTheDocument();
    await user.click(chip("Keep"));
    expect(screen.queryByRole("button", { name: /detection .*: old chair/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /detection .*: lamp/i })).toBeInTheDocument();
  });

  test("switching filters does not call any decision, exclusion or correction callback", async () => {
    const user = userEvent.setup();
    const props = baseProps({ reviewItems: rowsFixture() });
    render(<DeclutterReviewSection {...props} />);
    await user.click(chip("Sell"));
    await user.click(chip("All"));
    expect(props.setDecisionOverride).not.toHaveBeenCalled();
    expect(props.setItemExcluded).not.toHaveBeenCalled();
    expect(props.correctLabel).not.toHaveBeenCalled();
  });

  test("shows Please double check only on genuinely unresolved rows, and keeps it visible under every filter", async () => {
    const user = userEvent.setup();
    render(
      <DeclutterReviewSection
        {...baseProps({ reviewItems: [...rowsFixture(), unresolvedItem({ item_id: "item_050", clean_label: "mystery cable", effective_label: "mystery cable" })] })}
      />
    );
    expect(screen.getAllByText("Please double check")).toHaveLength(1);
    expect(screen.getByText("mystery cable").closest("li")).toHaveTextContent("Please double check");

    for (const label of ["Keep", "Sell", "Donate", "Discard", "All"]) {
      await user.click(chip(label));
      expect(screen.getByText("mystery cable")).toBeInTheDocument();
      expect(screen.getAllByText("Please double check")).toHaveLength(1);
    }
  });

  test("renders no raw item ids, confidence percentages or validity values anywhere in the review workspace", () => {
    const { container } = render(
      <DeclutterReviewSection
        {...baseProps({
          reviewItems: [
            ...rowsFixture(),
            unresolvedItem({ item_id: "item_050", clean_label: "mystery cable", effective_label: "mystery cable" }),
            contextualItem({ item_id: "item_099" }),
          ],
        })}
      />
    );
    expect(container.textContent).not.toMatch(/item_0\d\d|item_id|\d+\s*%|raw_valid|still_invalid|validity/i);
    expect(container.querySelector("code")).toBeNull();
    // overlay boxes are still keyed and named by item_id, so the boxes and rows stay linked
    expect(screen.getAllByRole("button", { name: /^detection \d+:/i }).length).toBeGreaterThan(0);
  });

  test("Back to top is lifted above the sticky decision bar's bottom slot, at both breakpoints", () => {
    const observers = [];
    const originalIO = global.IntersectionObserver;
    global.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.elements = [];
        observers.push(this);
      }
      observe(el) {
        this.elements.push(el);
      }
      disconnect() {}
    };
    try {
      render(<DeclutterReviewSection {...baseProps({ reviewItems: rowsFixture() })} enableBackToTop />);
      // scroll past the top sentinel: the first observer watches it
      act(() => observers[0].callback([{ isIntersecting: false }]));
      const button = screen.getByRole("button", { name: /back to top/i });
      const classes = button.className.split(/\s+/);
      expect(classes).toContain("fixed");
      expect(classes).toContain("bottom-44");
      expect(classes).toContain("sm:bottom-24");
      expect(classes).not.toContain("bottom-6");
    } finally {
      global.IntersectionObserver = originalIO;
    }
  });
});
