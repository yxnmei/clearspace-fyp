import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterItemCard from "./DeclutterItemCard";

function makeReviewItem(overrides = {}) {
  return {
    item_id: "item_001",
    raw_phrase: "picture frame painting",
    clean_label: "picture frame",
    position: "upper-left",
    relative_size: "small",
    confidence: 0.45,
    ai_decision: "discard",
    ai_reason: "duplicate, low confidence",
    item_validity: "raw_valid",
    is_expected: true,
    is_unresolved: false,
    review_decision: "discard",
    review_excluded: false,
    review_user_reason: null,
    decision_changed: false,
    has_decision_override: false,
    ...overrides,
  };
}

describe("DeclutterItemCard", () => {
  test("clicking a decision calls onDecisionChange with the item's item_id", async () => {
    const user = userEvent.setup();
    const onDecisionChange = vi.fn();
    render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={onDecisionChange} onExcludedChange={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "Keep" }));

    expect(onDecisionChange).toHaveBeenCalledWith("item_001", "keep");
  });

  test("toggling exclusion calls onExcludedChange with the item's item_id", async () => {
    const user = userEvent.setup();
    const onExcludedChange = vi.fn();
    render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={onExcludedChange} />);

    await user.click(screen.getByRole("checkbox"));

    expect(onExcludedChange).toHaveBeenCalledWith("item_001", true);
  });

  test("shows Changed and Excluded indicators when applicable", () => {
    render(
      <DeclutterItemCard
        item={makeReviewItem({ decision_changed: true, review_excluded: true })}
        onDecisionChange={vi.fn()}
        onExcludedChange={vi.fn()}
      />
    );
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(screen.getByText("Excluded")).toBeInTheDocument();
  });

  test("does not show Changed/Excluded indicators when not applicable", () => {
    render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
    expect(screen.queryByText("Changed")).not.toBeInTheDocument();
    expect(screen.queryByText("Excluded")).not.toBeInTheDocument();
  });

  test("the current review_decision is shown as selected", () => {
    render(<DeclutterItemCard item={makeReviewItem({ review_decision: "donate" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Donate" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Keep" })).not.toBeChecked();
  });

  test("decision controls are keyboard-focusable native radio inputs", async () => {
    // Native <input type="radio"> groups only put the CHECKED member in
    // the tab sequence (the others are reachable by arrow keys once the
    // group has focus) — this is real browser/jsdom radio semantics, not
    // a limitation of the component. review_decision is "discard" here,
    // so that's the one Tab lands on first.
    const user = userEvent.setup();
    render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);

    await user.tab();

    expect(screen.getByRole("radio", { name: "Discard" })).toHaveFocus();
  });

  test("shows a visible item number badge derived from item_id", () => {
    render(<DeclutterItemCard item={makeReviewItem({ item_id: "item_012" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  test("hovering the card calls onActivate; leaving calls onDeactivate", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    render(
      <DeclutterItemCard
        item={makeReviewItem()}
        onDecisionChange={vi.fn()}
        onExcludedChange={vi.fn()}
        onActivate={onActivate}
        onDeactivate={onDeactivate}
      />
    );

    await user.hover(screen.getByText("picture frame"));
    expect(onActivate).toHaveBeenCalled();

    await user.unhover(screen.getByText("picture frame"));
    expect(onDeactivate).toHaveBeenCalled();
  });

  test("focusing a control inside the card calls onActivate; focusing away calls onDeactivate", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    render(
      <div>
        <DeclutterItemCard
          item={makeReviewItem()}
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
          onActivate={onActivate}
          onDeactivate={onDeactivate}
        />
        <button type="button">outside</button>
      </div>
    );

    await user.tab(); // focuses the checked radio inside the card
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onDeactivate).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "outside" }).focus(); // focus leaves the card entirely
    expect(onDeactivate).toHaveBeenCalled();
  });

  test("isActive renders an aria-current marker for the overlay to key off of", () => {
    const { rerender } = render(
      <DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} isActive={false} />
    );
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");

    rerender(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} isActive={true} />);
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "true");
  });

  test("registerRef is called with the item's item_id and the DOM node on mount, and with null on unmount", () => {
    const registerRef = vi.fn();
    const { unmount } = render(
      <DeclutterItemCard item={makeReviewItem({ item_id: "item_005" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} registerRef={registerRef} />
    );

    expect(registerRef).toHaveBeenCalledWith("item_005", expect.any(HTMLElement));

    unmount();

    expect(registerRef).toHaveBeenCalledWith("item_005", null);
  });
});
