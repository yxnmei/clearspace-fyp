import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterConfirmationPanel from "./DeclutterConfirmationPanel";

function ddFor(labelText) {
  return screen.getByText(labelText).closest("div").querySelector("dd").textContent;
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
    ...overrides,
  };
}

describe("DeclutterConfirmationPanel", () => {
  test("shows only the real derived counts", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    expect(ddFor("Keep")).toBe("2");
    expect(ddFor("Sell")).toBe("1");
    expect(ddFor("Donate")).toBe("0");
    expect(ddFor("Discard")).toBe("3");
    expect(ddFor("Changed")).toBe("1");
    expect(ddFor("Excluded")).toBe("1");
    expect(ddFor("Unresolved")).toBe("0");
  });

  test("does not invent a reviewed-X-of-Y progress figure", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    expect(screen.queryByText(/reviewed \d+ of \d+|\d+ of \d+ reviewed|progress/i)).not.toBeInTheDocument();
  });

  test("Confirm decisions calls onConfirm", async () => {
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

  test("the confirming state is accessible: labelled 'Confirming…', disabled, aria-busy", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ confirmationStatus: "confirming", confirmDisabled: true })} />);
    const btn = screen.getByRole("button", { name: /confirming/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });

  test("while any item is unresolved it explains why confirmation is unavailable", () => {
    render(<DeclutterConfirmationPanel {...baseProps({ unresolvedCount: 2, confirmDisabled: true })} />);
    expect(screen.getByText(/resolve every unresolved item above before confirmation is available/i)).toBeInTheDocument();
    expect(ddFor("Unresolved")).toBe("2");
  });

  test("a confirmation failure is an alert and states decisions are preserved", () => {
    render(
      <DeclutterConfirmationPanel
        {...baseProps({ confirmationStatus: "error", confirmationError: "Decision confirmation failed" })}
      />
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/decision confirmation failed/i);
    expect(alert).toHaveTextContent(/your review decisions and exclusions are unchanged — you can try again/i);
  });

  test("no error alert while idle", () => {
    render(<DeclutterConfirmationPanel {...baseProps()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
