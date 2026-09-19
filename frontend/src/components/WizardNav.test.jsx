import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import WizardNav from "./WizardNav";

describe("WizardNav", () => {
  test("renders Back and Continue, wires their handlers, and honours disabled flags", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onContinue = vi.fn();
    render(
      <WizardNav
        backLabel="Back to Analyse"
        onBack={onBack}
        continueLabel="Continue to Confirm"
        onContinue={onContinue}
      />
    );

    const back = screen.getByRole("button", { name: /back to analyse/i });
    const cont = screen.getByRole("button", { name: /continue to confirm/i });
    expect(back).toHaveAttribute("type", "button");
    expect(cont).toHaveAttribute("type", "button");

    await user.click(back);
    await user.click(cont);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  test("a disabled Continue does not fire", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(<WizardNav continueLabel="Continue" onContinue={onContinue} continueDisabled />);
    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont).toBeDisabled();
    await user.click(cont);
    expect(onContinue).not.toHaveBeenCalled();
  });

  test("omitting onContinue renders only a Back control", () => {
    render(<WizardNav backLabel="Back to Review" onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: /back to review/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  test("a disabled Back does not fire", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<WizardNav backLabel="Back" onBack={onBack} backDisabled />);
    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeDisabled();
    await user.click(back);
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe("WizardNav, responsive layout", () => {
  // jsdom applies no Tailwind CSS, so these assert the class contract:
  // stacked + full width below sm, one row at natural widths from sm up.
  // The visual result is checked by hand at both breakpoints.
  test("the row stacks vertically below sm and returns to a horizontal row from sm up, Back first", () => {
    const { container } = render(
      <WizardNav backLabel="Back" onBack={vi.fn()} continueLabel="Continue" onContinue={vi.fn()} />
    );
    const row = container.firstChild;
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bsm:flex-row\b/);
    expect(row.className).toMatch(/\bsm:justify-between\b/);
    expect(row.className).toMatch(/\bgap-3\b/);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName("Back");
    expect(buttons[1]).toHaveAccessibleName("Continue");
  });

  test("both buttons are full width with centred content below sm and natural width from sm up", () => {
    render(<WizardNav backLabel="Back" onBack={vi.fn()} continueLabel="Continue" onContinue={vi.fn()} />);
    for (const name of ["Back", "Continue"]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).toMatch(/\bw-full\b/);
      expect(button.className).toMatch(/\bsm:w-auto\b/);
      expect(button.className).toMatch(/\bjustify-center\b/);
      expect(button.className).toMatch(/\binline-flex\b/);
    }
    // Continue keeps the right-hand slot on desktop without a placeholder
    expect(screen.getByRole("button", { name: "Continue" }).className).toMatch(/\bsm:ml-auto\b/);
  });

  test("Back-only renders a single control and no placeholder element", () => {
    const { container } = render(<WizardNav backLabel="Back to Review" onBack={vi.fn()} />);
    const row = container.firstChild;
    expect(row.children).toHaveLength(1);
    expect(row.querySelector("span:empty")).toBeNull();
    const back = screen.getByRole("button", { name: /back to review/i });
    expect(row.firstChild).toBe(back);
    expect(back.className).toMatch(/\bw-full\b/);
    expect(back.className).toMatch(/\bsm:w-auto\b/);
  });

  test("Continue-only renders a single control and no placeholder element", () => {
    const { container } = render(<WizardNav continueLabel="Continue to Confirm" onContinue={vi.fn()} />);
    const row = container.firstChild;
    expect(row.children).toHaveLength(1);
    expect(row.querySelector("span:empty")).toBeNull();
    const cont = screen.getByRole("button", { name: /continue to confirm/i });
    expect(row.firstChild).toBe(cont);
    expect(cont.className).toMatch(/\bw-full\b/);
    expect(cont.className).toMatch(/\bsm:w-auto\b/);
    expect(cont.className).toMatch(/\bsm:ml-auto\b/);
  });

  test("variants, icons and handlers are unchanged by the responsive classes", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onContinue = vi.fn();
    render(<WizardNav backLabel="Back" onBack={onBack} continueLabel="Continue" onContinue={onContinue} />);
    const back = screen.getByRole("button", { name: "Back" });
    const cont = screen.getByRole("button", { name: "Continue" });
    // outline Back, primary Continue, each with one decorative icon
    expect(back.className).toMatch(/\bborder-input\b/);
    expect(cont.className).toMatch(/\bbg-primary\b/);
    expect(back.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(cont.querySelector('svg[aria-hidden="true"]')).toBeTruthy();

    await user.click(back);
    await user.click(cont);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
