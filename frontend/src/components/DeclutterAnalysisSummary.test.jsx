import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import DeclutterAnalysisSummary from "./DeclutterAnalysisSummary";

function ddFor(labelText) {
  return screen.getByText(labelText).closest("div").querySelector("dd").textContent;
}

function makeAnalysis(overrides = {}) {
  return {
    scene: { label: "bedroom", confidence: 0.9604 },
    items: [{}, {}, {}],
    warnings: [],
    stage_timings: [{ stage: "detect", duration_ms: 4510 }],
    ...overrides,
  };
}

function makeDeclutter(overrides = {}) {
  return { expected_item_ids: ["item_001", "item_002"], ...overrides };
}

// Vocabulary that must never reach this screen.
const TECHNICAL = /candidate|detection|classification|reasoning|confidence|\d+%|\d+\.\d+s|analysis time|processing warning|warning code|\broom\b/i;

describe("DeclutterAnalysisSummary", () => {
  test("is a 'What we found' region headed by a single h2, with exactly three user-facing dt/dd pairs", () => {
    render(<DeclutterAnalysisSummary analysis={makeAnalysis()} declutter={makeDeclutter()} />);
    const region = screen.getByRole("region", { name: "What we found" });
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 2, name: "What we found" })).toBeInTheDocument();
    const dl = region.querySelector("dl");
    expect(dl).not.toBeNull();
    expect(Array.from(dl.querySelectorAll("dt")).map((dt) => dt.textContent)).toEqual([
      "Space type",
      "Items found",
      "Ready to review",
    ]);
    expect(dl.querySelectorAll("dd")).toHaveLength(3);
    expect(ddFor("Space type")).toBe("bedroom");
    expect(ddFor("Items found")).toBe("3");
    expect(ddFor("Ready to review")).toBe("2");
  });

  test("shows no confidence percentage, duration or pipeline vocabulary", () => {
    const { container } = render(<DeclutterAnalysisSummary analysis={makeAnalysis()} declutter={makeDeclutter()} />);
    expect(container.textContent).not.toMatch(TECHNICAL);
    expect(container.textContent).not.toMatch(/96/);
    expect(container.textContent).not.toMatch(/4\.5/);
    expect(screen.queryByText(/contextual/i)).not.toBeInTheDocument();
  });

  test("older callers may still pass contextualCount and totalDurationMs; neither is shown", () => {
    const { container } = render(
      <DeclutterAnalysisSummary analysis={makeAnalysis()} declutter={makeDeclutter()} contextualCount={4} totalDurationMs={4510} />
    );
    expect(container.textContent).not.toMatch(/\b4\b|4\.5|4510/);
  });

  test("does not invent a clutter score, quality score or reviewed count", () => {
    render(<DeclutterAnalysisSummary analysis={makeAnalysis()} declutter={makeDeclutter()} />);
    expect(screen.queryByText(/clutter score|quality|reviewed \d+ of \d+|progress/i)).not.toBeInTheDocument();
  });

  test("renders no warning block at all without warnings, and one calm sentence with them", () => {
    const { rerender, container } = render(
      <DeclutterAnalysisSummary analysis={makeAnalysis({ warnings: [] })} declutter={makeDeclutter()} />
    );
    expect(screen.queryByText(/extra review/i)).not.toBeInTheDocument();
    expect(container.querySelector(".border-warning\\/40")).toBeNull();

    rerender(
      <DeclutterAnalysisSummary
        analysis={makeAnalysis({ warnings: [{ code: "low_confidence_scene", detail: "internal" }, { code: "y" }] })}
        declutter={makeDeclutter()}
      />
    );
    const warning = screen.getByText("Some results may need extra review.");
    expect(warning.className).toMatch(/border-warning/);
    expect(warning.querySelector("svg")).not.toBeNull(); // icon + text, never colour alone
    expect(container.textContent).not.toMatch(/low_confidence_scene|internal|code|\b2\b warnings/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("stat cards stack on phones and sit three across from sm without overflow", () => {
    const { container } = render(<DeclutterAnalysisSummary analysis={makeAnalysis()} declutter={makeDeclutter()} />);
    const dl = container.querySelector("dl");
    expect(dl.className).toMatch(/\bgrid-cols-1\b/);
    expect(dl.className).toMatch(/\bsm:grid-cols-3\b/);
    for (const dd of dl.querySelectorAll("dd")) expect(dd.className).toMatch(/truncate/);
    expect(container.innerHTML).not.toMatch(/overflow-x-auto|w-screen|whitespace-nowrap/);
  });
});
