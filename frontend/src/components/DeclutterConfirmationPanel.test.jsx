import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterConfirmationPanel, { DECLUTTER_NEXT_STEP_NOTE } from "./DeclutterConfirmationPanel";

function ddFor(labelText) {
  const chips = screen.getByLabelText(/confirmed decisions|your decisions/i);
  return within(chips).getByText(labelText).closest("div").querySelector("dd").textContent;
}

function baseProps(overrides = {}) {
  return {
    counts: { keep: 2, sell: 1, donate: 0, discard: 3 },
    changedCount: 1,
    excludedCount: 1,
    unresolvedCount: 0,
    confirmDisabled: false,
    confirmationStatus: "idle",
    confirmationError: null,
    onConfirm: vi.fn(),
    confirmation: null,
    onReviewUnresolved: vi.fn(),
    ...overrides,
  };
}

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

function makeConfirmation(overrides = {}) {
  return {
    runId: "run7",
    confirmedDecisions: [
      makeConfirmedDecision({ item_id: "item_001", confirmed_decision: "keep" }),
      makeConfirmedDecision({ item_id: "item_002", ai_decision: "keep", confirmed_decision: "donate", decision_changed: true }),
      makeConfirmedDecision({ item_id: "item_003", confirmed_decision: "discard" }),
    ],
    confirmedKeepIds: ["item_001"],
    decisionChangedCount: 1,
    excludedCount: 0,
    response: {},
    ...overrides,
  };
}

const panel = () => screen.getByRole("region", { name: /confirm your choices|choices confirmed/i });

describe("DeclutterConfirmationPanel, before confirmation", () => {
  test("has the Confirm your choices heading, explains the next step, and shows only non-zero categories", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    expect(screen.getByRole("heading", { name: "Confirm your choices" })).toBeInTheDocument();
    expect(screen.getByText(/locks in the decisions below for the next step/i)).toBeInTheDocument();

    expect(ddFor("Keep")).toBe("2");
    expect(ddFor("Sell")).toBe("1");
    expect(ddFor("Discard")).toBe("3");
    expect(ddFor("Changed")).toBe("1");
    expect(ddFor("Excluded")).toBe("1");
    // zero-value categories are omitted, not rendered as empty cards
    expect(screen.queryByText("Donate")).not.toBeInTheDocument();
    expect(screen.queryByText("Unresolved")).not.toBeInTheDocument();
  });

  test("omits Changed and Excluded when zero, and renders no summary list when nothing has a count", () => {
    const { rerender } = render(<DeclutterConfirmationPanel {...baseProps({ changedCount: 0, excludedCount: 0 })} />);
    expect(screen.queryByText("Changed")).not.toBeInTheDocument();
    expect(screen.queryByText("Excluded")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/your decisions/i).tagName).toBe("DL");

    rerender(
      <DeclutterConfirmationPanel
        {...baseProps({ counts: { keep: 0, sell: 0, donate: 0, discard: 0 }, changedCount: 0, excludedCount: 0 })}
      />
    );
    expect(screen.queryByLabelText(/your decisions/i)).not.toBeInTheDocument();
    expect(document.querySelector("dl")).toBeNull();
  });

  test("every decision chip shares one solid surface and one green border, with only the icon in its decision colour", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ counts: { keep: 2, sell: 1, donate: 4, discard: 3 } })} />);
    const seen = new Set();
    for (const [label, token] of [["Keep", "keep"], ["Sell", "sell"], ["Donate", "donate"], ["Discard", "discard"]]) {
      const chip = screen.getByText(label).closest("div");
      const classes = chip.className.split(/\s+/);
      expect(classes).toContain("bg-surface");
      expect(classes).toContain("border-primary/50");
      expect(classes).toContain("text-foreground");
      expect(classes).toContain("rounded-pill");
      // no decision tint or decision-coloured border on the chip itself
      expect(chip.className).not.toMatch(/bg-decision-|border-decision-|text-decision-/);
      const icon = chip.querySelector('svg[aria-hidden="true"]');
      expect(icon.getAttribute("class").split(/\s+/)).toContain(`text-decision-${token}`);
      expect(chip.querySelector("dt")).toHaveTextContent(label);
      seen.add(token);
    }
    expect(seen.size).toBe(4); // four distinct icon tokens
  });

  test("Changed and Excluded stay secondary but visible: warning tint with a warning icon, neutral surface with a border", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    const changed = screen.getByText("Changed").closest("div");
    expect(changed.className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-warning/15", "border-warning/50", "text-foreground"]));
    expect(changed.querySelector("svg").getAttribute("class").split(/\s+/)).toContain("text-warning");
    const excluded = screen.getByText("Excluded").closest("div");
    expect(excluded.className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-surface-muted", "border-border", "text-foreground"]));
    expect(excluded.querySelector("svg").getAttribute("class").split(/\s+/)).toContain("text-muted-foreground");
  });

  test("the summary is a wrapping chip list, not a fixed grid, with a labelled dl", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    const list = screen.getByLabelText(/your decisions/i);
    expect(list.tagName).toBe("DL");
    expect(list.className).toMatch(/\bflex-wrap\b/);
    expect(list.className).not.toMatch(/grid-cols/);
    for (const chip of list.children) expect(chip.className).toMatch(/rounded-pill/);
  });

  test("does not invent a reviewed-X-of-Y progress figure", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    expect(screen.queryByText(/reviewed \d+ of \d+|\d+ of \d+ reviewed|progress/i)).not.toBeInTheDocument();
  });

  test("Confirm decisions calls onConfirm exactly once", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<DeclutterConfirmationPanel {...baseProps({ onConfirm })} />);
    await user.click(screen.getByRole("button", { name: /confirm decisions/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("the button is disabled and keyboard-focusable exactly when confirmDisabled is set", () => {
    const { rerender } = render(<DeclutterConfirmationPanel {...baseProps({ confirmDisabled: false })} />);
    const btn = screen.getByRole("button", { name: /confirm decisions/i });
    expect(btn).toBeEnabled();
    btn.focus();
    expect(btn).toHaveFocus();
    expect(btn.className).toMatch(/focus-visible:ring/); // visible focus ring from the Button primitive

    rerender(<DeclutterConfirmationPanel {...baseProps({ confirmDisabled: true })} />);
    expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeDisabled();
  });

  test("the primary action is full width with a 44px target on mobile and natural width from sm up", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    const classes = screen.getByRole("button", { name: /confirm decisions/i }).className.split(/\s+/);
    for (const cls of ["w-full", "min-h-11", "sm:w-auto"]) expect(classes).toContain(cls);
  });

  test("the confirming state is accessible: labelled 'Confirming…', disabled, aria-busy, with a spinner", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirming", confirmDisabled: true })} />);
    const btn = screen.getByRole("button", { name: /confirming/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Confirm your choices" })).toBeInTheDocument();
  });

  test("unresolved items keep confirmation blocked, state the exact count, and offer a real button back to Decide items", async () => {
    const user = userEvent.setup();
    const onReviewUnresolved = vi.fn();
    const onConfirm = vi.fn();
    render(
      <DeclutterConfirmationPanel {...baseProps({ unresolvedCount: 2, confirmDisabled: true, onReviewUnresolved, onConfirm })} />
    );
    expect(screen.getByText("2 items still need a decision before you can confirm.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeDisabled();

    const review = screen.getByRole("button", { name: "Review unresolved items" });
    expect(review.tagName).toBe("BUTTON");
    expect(review).toHaveAttribute("type", "button");
    await user.click(review);
    expect(onReviewUnresolved).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    // the blocker is an explanation, not an error alert
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("a single unresolved item is worded in the singular", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ unresolvedCount: 1, confirmDisabled: true })} />);
    expect(screen.getByText("1 item still needs a decision before you can confirm.")).toBeInTheDocument();
  });

  test("no unresolved block and no Review unresolved items button when every item is resolved", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ unresolvedCount: 0 })} />);
    expect(screen.queryByText(/still need/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review unresolved items/i })).not.toBeInTheDocument();
  });

  test("without a navigation handler the unresolved explanation still shows, without a dead button", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ unresolvedCount: 3, confirmDisabled: true, onReviewUnresolved: undefined })} />);
    expect(screen.getByText(/3 items still need a decision/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review unresolved items/i })).not.toBeInTheDocument();
  });

  test("a confirmation failure is an inline alert that states decisions are preserved, with Confirm still available", () => {
    render(
      <DeclutterConfirmationPanel
        {...baseProps({ confirmationStatus: "error", confirmationError: "Decision confirmation failed" })}
      />
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/decision confirmation failed/i);
    expect(alert).toHaveTextContent(/your review decisions and exclusions are unchanged. you can try again/i);
    expect(panel()).toContainElement(alert);
    expect(screen.getByRole("button", { name: /confirm decisions/i })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Confirm your choices" })).toBeInTheDocument();
  });

  test("no error alert while idle", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("DeclutterConfirmationPanel, after confirmation", () => {
  test("the same surface turns into the Choices confirmed success state with confirmed non-zero counts", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation: makeConfirmation() })} />);
    expect(screen.getByRole("heading", { name: "Choices confirmed" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Confirm your choices" })).not.toBeInTheDocument();
    // No count chips or Changed chip after confirmation: the grouped item
    // lists carry the categories, from the confirmation, not the live
    // review counts passed in.
    expect(screen.queryByLabelText(/confirmed decisions|your decisions/i)).not.toBeInTheDocument();
    const summary = screen.getByLabelText("Confirmed choices summary");
    expect(within(summary).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Keep", "Donate", "Discard"]);
    expect(within(summary).getByRole("list", { name: "Keep items" })).toBeInTheDocument();
    expect(within(summary).queryByRole("heading", { name: "Sell" })).not.toBeInTheDocument();
    expect(within(summary).queryByRole("heading", { name: "Excluded" })).not.toBeInTheDocument();
    expect(screen.queryByText(/locked in/i)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/go back to decide items to change one/i);
  });

  test("each category heading carries an Edit link that hands the category filter to the page", async () => {
    const user = userEvent.setup();
    const onEditCategory = vi.fn();
    render(
      <DeclutterConfirmationPanel
        {...baseProps({ confirmationStatus: "confirmed", confirmation: makeConfirmation(), onEditCategory })}
      />
    );
    await user.click(screen.getByRole("button", { name: "Edit Donate decisions" }));
    expect(onEditCategory).toHaveBeenCalledWith("donate");
    expect(screen.getAllByRole("button", { name: /^Edit .* decisions$/ })).toHaveLength(3);
  });

  test("without onEditCategory the confirmed panel offers no Edit links", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation: makeConfirmation() })} />);
    expect(screen.queryByRole("button", { name: /^Edit .* decisions$/ })).not.toBeInTheDocument();
  });

  test("announces success in a status region and describes the next step", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation: makeConfirmation() })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/3 decisions confirmed/i);
    expect(screen.getByText(DECLUTTER_NEXT_STEP_NOTE)).toBeInTheDocument();
    expect(panel().className).toMatch(/border-success/);
  });

  test("a single confirmed decision is worded in the singular", () => {
    render(
      <DeclutterConfirmationPanel
        {...baseProps({
          confirmationStatus: "confirmed",
          confirmation: makeConfirmation({ confirmedDecisions: [makeConfirmedDecision()], decisionChangedCount: 0 }),
        })}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(/1 decision confirmed/i);
  });

  test("a workflow-specific next-step note replaces the Declutter default", () => {
    render(
      <DeclutterConfirmationPanel
        {...baseProps({
          confirmationStatus: "confirmed",
          confirmation: makeConfirmation(),
          nextStepNote: "On the Results screen, Tidy up and Marketplace listings are separate actions.",
        })}
      />
    );
    expect(screen.getByText(/tidy up and marketplace listings are separate actions/i)).toBeInTheDocument();
    expect(screen.queryByText(DECLUTTER_NEXT_STEP_NOTE)).not.toBeInTheDocument();
  });

  test("shows Excluded only when the confirmation has exclusions", () => {
    const withExclusion = makeConfirmation({
      confirmedDecisions: [
        makeConfirmedDecision({ item_id: "item_001", confirmed_decision: "keep" }),
        makeConfirmedDecision({ item_id: "item_002", confirmed_decision: "discard", excluded: true }),
      ],
      excludedCount: 1,
    });
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation: withExclusion })} />);
    const summary = screen.getByLabelText("Confirmed choices summary");
    expect(within(summary).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Keep", "Excluded"]);
    expect(within(summary).queryByRole("heading", { name: "Discard" })).not.toBeInTheDocument();
  });

  test("exposes no run id, item id or hash, and offers Copy instead of Confirm", () => {
    const { container } = render(
      <DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation: makeConfirmation() })} />
    );
    expect(container.textContent).not.toMatch(/run7|run |item_00\d|item_id|sha|hash/i);
    expect(container.querySelector("code")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy summary" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm decisions" })).not.toBeInTheDocument();
    expect(screen.queryByText(/confirmed keep items/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("a confirmation object without a confirmed status is not treated as success (stale results stay hidden)", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "idle", confirmation: makeConfirmation() })} />);
    expect(screen.getByRole("heading", { name: "Confirm your choices" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Choices confirmed" })).not.toBeInTheDocument();
  });

  test("the panel is one region whose heading changes in place; before and after are never both rendered", () => {
    const { rerender } = render(<DeclutterConfirmationPanel {...baseProps()} />);
    expect(within(panel()).getByRole("heading", { name: "Confirm your choices" })).toBeInTheDocument();
    rerender(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation: makeConfirmation() })} />);
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(within(panel()).getByRole("heading", { name: "Choices confirmed" })).toBeInTheDocument();
  });
});

describe("DeclutterConfirmationPanel confirmed-choices summary", () => {
  const reviewItems = [
    { item_id: "item_001", effective_label: "lamp", box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 } },
    { item_id: "item_002", effective_label: "book", box: { x1: 0.2, y1: 0.1, x2: 0.3, y2: 0.2 } },
    { item_id: "item_003", effective_label: "book", box: { x1: 0.3, y1: 0.1, x2: 0.4, y2: 0.2 } },
    { item_id: "item_004", effective_label: "box", box: { x1: 0.4, y1: 0.1, x2: 0.5, y2: 0.2 } },
  ];
  const confirmation = makeConfirmation({
    confirmedDecisions: [
      makeConfirmedDecision({ item_id: "item_001" }),
      makeConfirmedDecision({ item_id: "item_002", ai_decision: "sell", confirmed_decision: "donate", decision_changed: true }),
      makeConfirmedDecision({ item_id: "item_003", ai_decision: "donate", confirmed_decision: "donate" }),
      makeConfirmedDecision({ item_id: "item_004", ai_decision: "discard", confirmed_decision: "discard", excluded: true }),
    ],
    excludedCount: 1,
  });

  test("groups by confirmed choice, separates excluded and joins duplicate labels by item_id", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation, reviewItems, imageUrl: "blob:test" })} />);
    const summary = screen.getByLabelText("Confirmed choices summary");
    expect(within(summary).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Keep", "Donate", "Excluded"]);
    expect(within(summary).getAllByText("book")).toHaveLength(2);
    expect(within(summary).getByText("lamp")).toBeInTheDocument();
    expect(within(summary).getByText("box")).toBeInTheDocument();
    expect(within(summary).getByText("Changed")).toBeInTheDocument();
    expect(summary.textContent).not.toMatch(/item_00|ai_reason|user_reason/);
  });

  test("copies one line per non-empty group with repeated labels counted", async () => {
    const user = userEvent.setup();
    const writer = vi.fn().mockResolvedValue(undefined);
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation, reviewItems, clipboardWriter: writer })} />);
    await user.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writer).toHaveBeenCalledWith("Keep: lamp\nDonate: book (2)\nExcluded: box");
    expect(await screen.findByText("Summary copied to your clipboard.")).toBeInTheDocument();
  });

  test("keeps irregular labels unchanged when counting duplicates", async () => {
    const user = userEvent.setup();
    const writer = vi.fn().mockResolvedValue(undefined);
    const shelves = reviewItems.slice(1, 3).map((entry) => ({ ...entry, effective_label: "shelf" }));
    const shelfConfirmation = makeConfirmation({
      confirmedDecisions: [
        makeConfirmedDecision({ item_id: "item_002" }),
        makeConfirmedDecision({ item_id: "item_003" }),
      ],
    });
    render(<DeclutterConfirmationPanel {...baseProps({
      confirmationStatus: "confirmed", confirmation: shelfConfirmation, reviewItems: shelves, clipboardWriter: writer,
    })} />);
    await user.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writer).toHaveBeenCalledWith("Keep: shelf (2)");
  });

  test("copy failure is generic and does not alter the summary", async () => {
    const user = userEvent.setup();
    const writer = vi.fn().mockRejectedValue(new Error("private clipboard detail"));
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirmed", confirmation, reviewItems, clipboardWriter: writer })} />);
    await user.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(await screen.findByText("Could not copy the summary. Nothing has changed.")).toBeInTheDocument();
    expect(screen.queryByText(/private clipboard detail/)).not.toBeInTheDocument();
    expect(screen.getByText("lamp")).toBeInTheDocument();
  });

  test("no copy action before confirmation and no em dash", () => {
    const { container } = render(<DeclutterConfirmationPanel {...baseProps({ reviewItems })} />);
    expect(screen.queryByRole("button", { name: "Copy summary" })).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("\u2014");
  });
});
