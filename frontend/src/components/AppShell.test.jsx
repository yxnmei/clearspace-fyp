import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import AppShell from "./AppShell";

describe("AppShell", () => {
  test("renders a banner header with the ClearSpace brand and the page content", () => {
    render(
      <AppShell>
        <p>page body</p>
      </AppShell>
    );
    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent(/clearspace/i);
    expect(screen.getByRole("main")).toHaveTextContent("page body");
  });

  test("no Back to workflows control unless onBack is provided", () => {
    render(<AppShell>x</AppShell>);
    expect(screen.queryByRole("button", { name: /back to workflows/i })).not.toBeInTheDocument();
  });

  test("shows a real Back to workflows button that calls onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<AppShell onBack={onBack}>x</AppShell>);

    const back = screen.getByRole("button", { name: /back to workflows/i });
    expect(back).toHaveAttribute("type", "button");
    await user.click(back);
    // Leaving discards the mounted workflow, so the button asks first.
    expect(onBack).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  describe("leave guard", () => {
    test("Back opens an alertdialog that takes focus, Stay closes it and returns focus, nothing is called", async () => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      render(<AppShell onBack={onBack}>x</AppShell>);
      const back = screen.getByRole("button", { name: /back to workflows/i });
      await user.click(back);
      const dialog = screen.getByRole("alertdialog", { name: "Leave this workflow?" });
      expect(dialog).toHaveTextContent(/decisions and drafts here will be lost/i);
      expect(screen.getByRole("button", { name: "Stay" })).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "Stay" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(back).toHaveFocus();
      expect(onBack).not.toHaveBeenCalled();
    });

    test("Escape closes the guard without leaving", async () => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      render(<AppShell onBack={onBack}>x</AppShell>);
      await user.click(screen.getByRole("button", { name: /back to workflows/i }));
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(onBack).not.toHaveBeenCalled();
    });

    test("the brand is a button named ClearSpace home only while a workflow is open, and goes through the same guard", async () => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      const { rerender } = render(<AppShell>x</AppShell>);
      expect(screen.queryByRole("button", { name: "ClearSpace home" })).not.toBeInTheDocument();
      expect(screen.getByText("ClearSpace")).toBeInTheDocument();

      rerender(<AppShell onBack={onBack}>x</AppShell>);
      const home = screen.getByRole("button", { name: "ClearSpace home" });
      await user.click(home);
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      expect(onBack).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Leave" }));
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      // The text button keeps its unique name alongside the brand button.
      expect(screen.getAllByRole("button", { name: /back to workflows/i })).toHaveLength(1);
    });
  });

  test("has no fake account, notification or settings chrome", () => {
    render(<AppShell onBack={vi.fn()}>x</AppShell>);
    expect(
      screen.queryByRole("button", { name: /account|profile|sign in|log in|notification|settings|menu/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /avatar/i })).not.toBeInTheDocument();
  });

  test("provides a bounded, responsive content column", () => {
    render(<AppShell>x</AppShell>);
    const main = screen.getByRole("main");
    expect(main.className).toMatch(/max-w-content/);
    expect(main.className).toMatch(/mx-auto/);
    expect(main.className).toMatch(/px-4/);
    expect(main.className).toMatch(/sm:px-6/);
  });

  test("no workflow breadcrumb chip unless workflowName is provided", () => {
    render(<AppShell onBack={vi.fn()}>x</AppShell>);
    const header = screen.getByRole("banner");
    expect(within(header).queryByText(/workflow:/i)).not.toBeInTheDocument();
    expect(header).not.toHaveTextContent(/declutter|reorganise|both/i);
  });

  test("names the active workflow in the header breadcrumb, once, and only from sm up (the mobile stepper carries it below sm)", () => {
    render(
      <AppShell onBack={vi.fn()} workflowName="Declutter">
        x
      </AppShell>
    );
    const header = screen.getByRole("banner");
    expect(within(header).getByText(/^clearspace$/i)).toBeInTheDocument();
    const chip = within(header).getByText("Declutter");
    expect(within(header).getAllByText("Declutter")).toHaveLength(1);
    expect(chip.className).toMatch(/\bhidden\b/);
    expect(chip.className).toMatch(/sm:inline-flex/);
    // the chip is a label, never a control
    expect(within(header).queryByRole("button", { name: /declutter/i })).not.toBeInTheDocument();
    expect(within(header).queryByRole("link")).not.toBeInTheDocument();
  });

  test("keeps the Back to workflows control alongside the breadcrumb", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <AppShell onBack={onBack} workflowName="Both">
        x
      </AppShell>
    );
    await user.click(screen.getByRole("button", { name: /back to workflows/i }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("the decorative background layer is hidden from assistive tech", () => {
    const { container } = render(<AppShell>x</AppShell>);
    const decorative = container.querySelector('[aria-hidden="true"]');
    expect(decorative).toBeTruthy();
    expect(decorative.className).toMatch(/pointer-events-none/);
  });
});
