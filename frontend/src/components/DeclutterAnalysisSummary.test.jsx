import { render, screen } from "@testing-library/react";
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
    ...overrides,
  };
}

function makeDeclutter(overrides = {}) {
  return { expected_item_ids: ["item_001", "item_002"], ...overrides };
}

describe("DeclutterAnalysisSummary", () => {
  test("shows only the real analysis values, each in its own dt/dd pair", () => {
    render(
      <DeclutterAnalysisSummary
        analysis={makeAnalysis()}
        declutter={makeDeclutter()}
        contextualCount={4}
        totalDurationMs={4510}
      />
    );

    expect(ddFor("Scene")).toBe("bedroom (96%)");
    expect(ddFor("Candidate detections")).toBe("3");
    expect(ddFor("Candidates sent for suggestions")).toBe("2");
    expect(ddFor("Contextual items")).toBe("4");
    expect(ddFor("Processing warnings")).toBe("0");
    expect(ddFor("Analysis time")).toBe("4.5s");
  });

  test("keeps the careful 'Candidate detections' wording, not a completeness claim", () => {
    render(
      <DeclutterAnalysisSummary analysis={makeAnalysis()} declutter={makeDeclutter()} contextualCount={0} totalDurationMs={0} />
    );
    expect(screen.getByText("Candidate detections")).toBeInTheDocument();
    expect(screen.queryByText(/detected items/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/all items/i)).not.toBeInTheDocument();
  });

  test("does not invent a clutter score, room quality score or reviewed count", () => {
    render(
      <DeclutterAnalysisSummary analysis={makeAnalysis()} declutter={makeDeclutter()} contextualCount={0} totalDurationMs={0} />
    );
    expect(screen.queryByText(/clutter score|room quality|reviewed \d+ of \d+|progress/i)).not.toBeInTheDocument();
  });

  test("warnings cell is emphasised only when there is at least one warning", () => {
    const { rerender } = render(
      <DeclutterAnalysisSummary
        analysis={makeAnalysis({ warnings: [] })}
        declutter={makeDeclutter()}
        contextualCount={0}
        totalDurationMs={0}
      />
    );
    const calm = screen.getByText("Processing warnings").closest("div").parentElement;
    expect(calm.className).not.toMatch(/border-warning/);

    rerender(
      <DeclutterAnalysisSummary
        analysis={makeAnalysis({ warnings: [{ code: "x" }, { code: "y" }] })}
        declutter={makeDeclutter()}
        contextualCount={0}
        totalDurationMs={0}
      />
    );
    expect(ddFor("Processing warnings")).toBe("2");
    const warned = screen.getByText("Processing warnings").closest("div").parentElement;
    expect(warned.className).toMatch(/border-warning/);
  });
});
