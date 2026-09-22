import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import ReorganiseAnalysisSummary from "./ReorganiseAnalysisSummary";

function ddFor(labelText) {
  return screen.getByText(labelText).closest("div").querySelector("dd").textContent;
}

function makeAnalysis(overrides = {}) {
  return {
    scene: { label: "study", confidence: 0.81 },
    items: [
      { item_role: "actionable" },
      { item_role: "actionable" },
      { item_role: "contextual" },
      { item_role: "actionable" },
    ],
    warnings: [],
    stage_timings: [{ stage: "detect", duration_ms: 2200 }],
    ...overrides,
  };
}

const TECHNICAL = /candidate|detection|classification|reasoning|confidence|\d+%|\d+\.\d+s|analysis time|processing warning|included in plan|\broom\b/i;

describe("ReorganiseAnalysisSummary", () => {
  test("is a 'What we found' region with Space type, Items found and Available to include", () => {
    render(<ReorganiseAnalysisSummary analysis={makeAnalysis()} />);
    const region = screen.getByRole("region", { name: "What we found" });
    expect(within(region).getByRole("heading", { level: 2, name: "What we found" })).toBeInTheDocument();
    const dl = region.querySelector("dl");
    expect(Array.from(dl.querySelectorAll("dt")).map((dt) => dt.textContent)).toEqual([
      "Space type",
      "Items found",
      "Available to include",
    ]);
    expect(ddFor("Space type")).toBe("study");
    expect(ddFor("Items found")).toBe("4");
    expect(ddFor("Available to include")).toBe("3"); // actionable only
  });

  test("shows no confidence percentage, duration, contextual count or pipeline vocabulary", () => {
    const { container } = render(<ReorganiseAnalysisSummary analysis={makeAnalysis()} />);
    expect(container.textContent).not.toMatch(TECHNICAL);
    expect(container.textContent).not.toMatch(/81|2\.2/);
    expect(screen.queryByText(/contextual/i)).not.toBeInTheDocument();
  });

  test("renders no warning block without warnings, and one calm sentence with them", () => {
    const { rerender, container } = render(<ReorganiseAnalysisSummary analysis={makeAnalysis()} />);
    expect(screen.queryByText(/extra review/i)).not.toBeInTheDocument();

    rerender(<ReorganiseAnalysisSummary analysis={makeAnalysis({ warnings: [{ code: "x", detail: "internal" }] })} />);
    const warning = screen.getByText("Some results may need extra review.");
    expect(warning.className).toMatch(/border-warning/);
    expect(warning.querySelector("svg")).not.toBeNull();
    expect(container.textContent).not.toMatch(/internal|code/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("stat cards stack on phones and sit three across from sm", () => {
    const { container } = render(<ReorganiseAnalysisSummary analysis={makeAnalysis()} />);
    const dl = container.querySelector("dl");
    expect(dl.className).toMatch(/\bgrid-cols-1\b/);
    expect(dl.className).toMatch(/\bsm:grid-cols-3\b/);
    expect(container.innerHTML).not.toMatch(/overflow-x-auto|w-screen|whitespace-nowrap/);
  });
});
