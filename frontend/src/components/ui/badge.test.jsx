import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Badge, badgeVariants } from "./badge";

describe("Badge", () => {
  test("renders its content as a non-interactive span", () => {
    render(<Badge>New</Badge>);
    const badge = screen.getByText("New");
    expect(badge.tagName).toBe("SPAN");
    expect(badge).not.toHaveAttribute("role");
  });

  test("default variant uses the accent token", () => {
    render(<Badge>Default</Badge>);
    expect(screen.getByText("Default").className).toMatch(/bg-accent/);
  });

  test.each([
    ["success", /bg-success/],
    ["warning", /bg-warning/],
    ["error", /bg-error/],
    ["primary", /bg-primary/],
    ["outline", /border-border/],
  ])("variant %s maps to its semantic token", (variant, pattern) => {
    render(<Badge variant={variant}>{variant}</Badge>);
    expect(screen.getByText(variant).className).toMatch(pattern);
  });

  test("caller className is merged", () => {
    render(<Badge className="absolute right-3 top-3">Pinned</Badge>);
    const cls = screen.getByText("Pinned").className;
    expect(cls).toMatch(/absolute/);
    expect(cls).toMatch(/rounded-pill/); // base retained
  });

  test("badgeVariants is callable directly", () => {
    expect(typeof badgeVariants()).toBe("string");
    expect(badgeVariants({ variant: "success" })).toMatch(/bg-success/);
  });
});
