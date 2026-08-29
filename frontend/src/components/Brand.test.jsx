import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import Brand from "./Brand";

describe("Brand", () => {
  test("shows the ClearSpace wordmark by default", () => {
    render(<Brand />);
    expect(screen.getByText("ClearSpace")).toBeVisible();
  });

  test("keeps an accessible 'ClearSpace' name even with the wordmark hidden", () => {
    render(<Brand showWordmark={false} />);
    const wordmark = screen.getByText("ClearSpace");
    expect(wordmark).toBeInTheDocument();
    expect(wordmark.className).toMatch(/sr-only/); // present for assistive tech, hidden visually
  });

  test("the leaf glyph is decorative (hidden from the accessibility tree)", () => {
    const { container } = render(<Brand />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  test("merges a caller className onto the root", () => {
    const { container } = render(<Brand className="gap-4" />);
    expect(container.firstChild.className).toMatch(/gap-4/);
    expect(container.firstChild.className).toMatch(/inline-flex/);
  });
});
