import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import PathChip from "./PathChip";

describe("PathChip", () => {
  test.each(["Declutter", "Reorganise", "Both"])("shows the %s workflow name as visible text", (name) => {
    render(<PathChip workflowName={name} />);
    expect(screen.getByText(name)).toBeInTheDocument();
  });

  test("prefixes the name with a visually hidden 'Workflow:' for assistive tech", () => {
    render(<PathChip workflowName="Declutter" />);
    const prefix = screen.getByText(/workflow:/i);
    expect(prefix.className).toMatch(/sr-only/);
    expect(prefix.parentElement).toHaveTextContent(/workflow:\s*declutter/i);
  });

  test("the icon is decorative only; the chip is never a control", () => {
    const { container } = render(<PathChip workflowName="Both" />);
    const icon = container.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("an unknown workflow name still renders as text, without an icon", () => {
    const { container } = render(<PathChip workflowName="Other" />);
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });

  test("accepts extra classes for responsive placement", () => {
    render(<PathChip workflowName="Declutter" className="hidden sm:inline-flex" />);
    const chip = screen.getByText("Declutter");
    expect(chip.className).toMatch(/\bhidden\b/);
    expect(chip.className).toMatch(/sm:inline-flex/);
  });
});
