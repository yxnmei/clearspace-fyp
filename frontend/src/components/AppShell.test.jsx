import { render, screen } from "@testing-library/react";
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
    expect(onBack).toHaveBeenCalledTimes(1);
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

  test("the decorative background layer is hidden from assistive tech", () => {
    const { container } = render(<AppShell>x</AppShell>);
    const decorative = container.querySelector('[aria-hidden="true"]');
    expect(decorative).toBeTruthy();
    expect(decorative.className).toMatch(/pointer-events-none/);
  });
});
