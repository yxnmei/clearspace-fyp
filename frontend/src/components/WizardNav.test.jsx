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
});
