import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DecisionActionBar, { describeContinueBlocker } from "./DecisionActionBar";

function renderBar(overrides = {}) {
  const props = {
    totalCount: 12,
    counts: { keep: 3, sell: 4, donate: 3, discard: 2 },
    backLabel: "Back to Analyse space",
    onBack: vi.fn(),
    continueLabel: "Continue to Confirm choices",
    onContinue: vi.fn(),
    continueDisabled: false,
    blockedReason: null,
    ...overrides,
  };
  const utils = render(<DecisionActionBar {...props} />);
  return { ...utils, props };
}

describe("describeContinueBlocker", () => {
  test("returns null when nothing blocks Continue", () => {
    expect(describeContinueBlocker({ hasAnalysis: true, navigationLocked: false, correctingItemId: null, unresolvedCount: 0 })).toBeNull();
    expect(describeContinueBlocker()).toBeNull();
  });

  test("explains every existing blocker, in the order they take precedence", () => {
    expect(describeContinueBlocker({ navigationLocked: true, unresolvedCount: 3 })).toMatch(/wait for the current action to finish/i);
    expect(describeContinueBlocker({ hasAnalysis: false, unresolvedCount: 3 })).toMatch(/space analysis is unavailable/i);
    expect(describeContinueBlocker({ correctingItemId: "item_003", unresolvedCount: 3 })).toMatch(/label correction is in progress/i);
    expect(describeContinueBlocker({ unresolvedCount: 1 })).toBe("1 item still needs a decision.");
    expect(describeContinueBlocker({ unresolvedCount: 3 })).toBe("3 items still need a decision.");
  });
});

describe("DecisionActionBar", () => {
  test("is a labelled region with the total, the non-zero decision counts (icon + label + number) and one Back and one Continue", () => {
    renderBar();
    const bar = screen.getByRole("region", { name: /decision summary and navigation/i });
    expect(within(bar).getByText("12 items")).toBeInTheDocument();
    for (const [label, count] of [["Keep", "3"], ["Sell", "4"], ["Donate", "3"], ["Discard", "2"]]) {
      const term = within(bar).getByText(label);
      expect(term.tagName).toBe("DT");
      expect(term.nextElementSibling).toHaveTextContent(count);
      expect(term.parentElement.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
      expect(term.parentElement.className).toMatch(new RegExp(`text-decision-${label.toLowerCase()}`));
    }
    expect(within(bar).getAllByRole("button")).toHaveLength(2);
    expect(within(bar).getByRole("button", { name: /back to analyse space/i })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /continue to confirm choices/i })).toBeInTheDocument();
    expect(bar.textContent).not.toMatch(/%/);
  });

  test("omits zero counts and pluralises the total correctly", () => {
    renderBar({ totalCount: 1, counts: { keep: 1, sell: 0, donate: 0, discard: 0 } });
    expect(screen.getByText("1 item")).toBeInTheDocument();
    expect(screen.getByText("Keep")).toBeInTheDocument();
    expect(screen.queryByText("Sell")).not.toBeInTheDocument();
    expect(screen.queryByText("Donate")).not.toBeInTheDocument();
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
  });

  test("counts follow the props, so they update live from the current decisions", () => {
    const { rerender, props } = renderBar({ counts: { keep: 2, sell: 1, donate: 0, discard: 0 } });
    expect(screen.getByText("Keep").nextElementSibling).toHaveTextContent("2");
    rerender(<DecisionActionBar {...props} counts={{ keep: 1, sell: 2, donate: 0, discard: 0 }} />);
    expect(screen.getByText("Keep").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Sell").nextElementSibling).toHaveTextContent("2");
  });

  test("wires Back and Continue and honours their disabled flags", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    await user.click(screen.getByRole("button", { name: /back to analyse space/i }));
    await user.click(screen.getByRole("button", { name: /continue to confirm choices/i }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  test("a disabled Continue does not fire and is described by the visible reason", async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ continueDisabled: true, blockedReason: "1 item still needs a decision." });
    const cont = screen.getByRole("button", { name: /continue to confirm choices/i });
    expect(cont).toBeDisabled();
    await user.click(cont);
    expect(props.onContinue).not.toHaveBeenCalled();

    const reason = screen.getByRole("status");
    expect(reason).toHaveTextContent("1 item still needs a decision.");
    expect(cont).toHaveAttribute("aria-describedby", reason.id);
    // Back stays usable while only Continue is blocked
    expect(screen.getByRole("button", { name: /back to analyse space/i })).toBeEnabled();
  });

  test("a disabled Back does not fire", async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ backDisabled: true });
    const back = screen.getByRole("button", { name: /back to analyse space/i });
    expect(back).toBeDisabled();
    await user.click(back);
    expect(props.onBack).not.toHaveBeenCalled();
  });

  test("no reason is rendered while Continue is enabled, or when no reason is supplied", () => {
    const { rerender, props } = renderBar({ continueDisabled: false, blockedReason: "stale reason" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<DecisionActionBar {...props} continueDisabled blockedReason={null} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).not.toHaveAttribute("aria-describedby");
  });

  test("sticks to the bottom of the viewport as a restrained bar, stacking its controls full width below sm and returning to one row from sm up", () => {
    renderBar();
    const bar = screen.getByRole("region", { name: /decision summary and navigation/i });
    const classes = bar.className.split(/\s+/);
    expect(classes).toContain("sticky");
    expect(bar.className).not.toMatch(/overflow-x-auto|whitespace-nowrap/);

    const row = bar.firstElementChild;
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bsm:flex-row\b/);
    expect(row.className).toMatch(/\bsm:justify-between\b/);

    for (const name of [/back to analyse space/i, /continue to confirm choices/i]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).toMatch(/\bw-full\b/);
      expect(button.className).toMatch(/\bsm:w-auto\b/);
      expect(button.className).toMatch(/\bjustify-center\b/);
    }
    // the count list wraps rather than forcing width
    expect(bar.querySelector("dl").className).toMatch(/\bflex-wrap\b/);
  });

  test("is the same floating, content-width mint panel at every breakpoint", () => {
    renderBar();
    const bar = screen.getByRole("region", { name: /decision summary and navigation/i });
    const classes = bar.className.split(/\s+/);

    // base (mobile) already carries the full panel treatment
    for (const cls of ["sticky", "bottom-3", "mx-0", "rounded-card", "border", "border-border", "bg-accent/90", "backdrop-blur", "shadow-elevated"]) {
      expect(classes).toContain(cls);
    }
    // desktop only lifts it a little further
    expect(classes).toContain("lg:bottom-4");

    // no edge-to-edge dock remnants: negative margins, top-only border, white mobile surface
    expect(bar.className).not.toMatch(/-mx-\d|sm:-mx-\d|\bborder-t\b|bg-surface\/95|lg:rounded-card|lg:bg-accent/);

    // restrained responsive padding
    expect(classes).toContain("px-3");
    expect(classes).toContain("sm:px-4");

    // never viewport-wide: no fixed positioning or full-viewport width
    expect(classes).not.toContain("fixed");
    expect(bar.className).not.toMatch(/w-screen|inset-x-0|-mx/);
  });
});
