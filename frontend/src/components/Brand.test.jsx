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

  test("uses the bundled ClearSpace logo as a decorative brand mark", () => {
    const { container } = render(<Brand />);
    const logo = container.querySelector("img");
    expect(logo).toBeTruthy();
    expect(logo.getAttribute("src")).toContain("clearspace-logo.svg");
    expect(logo).toHaveAttribute("alt", "");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).toHaveAttribute("width", "36");
    expect(logo).toHaveAttribute("height", "36");
  });

  test("supports an explicit logo size", () => {
    const { container } = render(<Brand iconSize={28} />);
    const logo = container.querySelector("img");
    expect(logo).toHaveAttribute("width", "28");
    expect(logo).toHaveAttribute("height", "28");
  });

  test("merges a caller className onto the root", () => {
    const { container } = render(<Brand className="gap-4" />);
    expect(container.firstChild.className).toMatch(/gap-4/);
    expect(container.firstChild.className).toMatch(/inline-flex/);
  });
});
