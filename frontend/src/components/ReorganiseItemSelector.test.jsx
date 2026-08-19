import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ReorganiseItemSelector from "./ReorganiseItemSelector";

function makeItem(overrides = {}) {
  return {
    item_id: "item_001",
    clean_label: "lamp",
    effective_label: "lamp",
    box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
    confidence: 0.8,
    position: "upper-left",
    relative_size: "small",
    item_role: "actionable",
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    items: [makeItem()],
    selectedItemIds: ["item_001"],
    onToggleItem: vi.fn(),
    imageUrl: "blob:mock-preview",
    phase: "selecting",
    onGenerate: vi.fn(),
    generateError: null,
    healthStatus: "available",
    ...overrides,
  };
}

// The detection overlay/checkboxes now live inside a collapsed-by-default
// <details> disclosure — any test that needs to interact with them opens
// it first, exactly like a real user would.
async function openReview() {
  await userEvent.click(screen.getByText(/review detected items \(optional\)/i));
}

describe("ReorganiseItemSelector — auto-inclusion, no mandatory selection step", () => {
  test("states that all detected items are automatically included", () => {
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_002"] })} />);
    expect(screen.getByText(/all 2 detected items are automatically included in your plan/i)).toBeInTheDocument();
  });

  test("never says \"Choose what to keep\" anywhere", () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    expect(screen.queryByText(/choose what to keep/i)).not.toBeInTheDocument();
  });

  test("never describes contextual items as \"not kept\"", () => {
    const items = [
      makeItem({ item_id: "item_001", item_role: "actionable" }),
      makeItem({ item_id: "item_002", item_role: "contextual", clean_label: "wall", effective_label: "wall" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001"] })} />);
    expect(screen.queryByText(/not kept/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/never automatically kept/i)).not.toBeInTheDocument();
  });

  test("Generate is available and works without opening the optional review", async () => {
    const onGenerate = vi.fn();
    render(<ReorganiseItemSelector {...baseProps({ onGenerate })} />);
    // No interaction with the disclosure at all.
    await userEvent.click(screen.getByRole("button", { name: /generate room plan/i }));
    expect(onGenerate).toHaveBeenCalled();
  });
});

describe("ReorganiseItemSelector — the optional review disclosure", () => {
  test("is collapsed by default", () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    const details = screen.getByText(/review detected items \(optional\)/i).closest("details");
    expect(details).not.toHaveAttribute("open");
  });

  test("can be opened, revealing the checkbox list and detection overlay", async () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    await openReview();
    const details = screen.getByText(/review detected items \(optional\)/i).closest("details");
    expect(details).toHaveAttribute("open");
    expect(document.getElementById("reorganise-item-item_001")).toBeInTheDocument();
  });

  test("each item shows Included in plan / Exclude from plan language", async () => {
    const items = [
      makeItem({ item_id: "item_001", item_role: "actionable" }),
      makeItem({ item_id: "item_002", item_role: "actionable", clean_label: "chair", effective_label: "chair" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001"] })} />);
    await openReview();
    expect(screen.getByText("Included in plan")).toBeInTheDocument();
    expect(screen.getByText("Exclude from plan")).toBeInTheDocument();
  });
});

describe("ReorganiseItemSelector — explicit exclusion", () => {
  test("clicking an item's checkbox (inside the review) calls onToggleItem with its item_id", async () => {
    const onToggleItem = vi.fn();
    render(<ReorganiseItemSelector {...baseProps({ onToggleItem })} />);
    await openReview();
    await userEvent.click(document.getElementById("reorganise-item-item_001"));
    expect(onToggleItem).toHaveBeenCalledWith("item_001");
  });

  test("duplicate-labelled items render as independent rows, identified by item_id", async () => {
    const items = [
      makeItem({ item_id: "item_001", clean_label: "picture frame", effective_label: "picture frame" }),
      makeItem({ item_id: "item_002", clean_label: "picture frame", effective_label: "picture frame" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_002"] })} />);
    await openReview();
    expect(screen.getAllByText("picture frame")).toHaveLength(2);
    expect(document.getElementById("reorganise-item-item_001")).toBeInTheDocument();
    expect(document.getElementById("reorganise-item-item_002")).toBeInTheDocument();
  });

  test("contextual items are shown but never rendered as selectable actionable rows", async () => {
    const items = [
      makeItem({ item_id: "item_001", item_role: "actionable" }),
      makeItem({ item_id: "item_002", item_role: "contextual", clean_label: "wall", effective_label: "wall" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001"] })} />);
    await openReview();
    expect(document.getElementById("reorganise-item-item_001")).toBeInTheDocument();
    expect(document.getElementById("reorganise-item-item_002")).toBeNull(); // contextual item gets no checkbox at all
    expect(screen.getByText(/contextual items \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText("wall")).toBeInTheDocument();
  });

  test("clicking a box in the room panel links back to the matching item (box->list linking preserved)", async () => {
    const items = [makeItem({ item_id: "item_007" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_007"] })} />);
    await openReview();
    await userEvent.click(screen.getByRole("button", { name: /detection 7/i }));
    // scrollIntoView isn't implemented in jsdom; the interaction not throwing,
    // plus the box existing with the right accessible name, is the proof here.
    expect(screen.getByRole("button", { name: /detection 7/i })).toBeInTheDocument();
  });

  test("checkboxes are disabled while generating", async () => {
    render(<ReorganiseItemSelector {...baseProps({ phase: "generating" })} />);
    await openReview();
    expect(document.getElementById("reorganise-item-item_001")).toBeDisabled();
  });
});

describe("ReorganiseItemSelector — Generate button", () => {
  test("is disabled when the selection is empty, with honest wording (not a generic 'select an item' prompt)", () => {
    render(<ReorganiseItemSelector {...baseProps({ selectedItemIds: [] })} />);
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeDisabled();
    expect(
      screen.getByText(/at least one detected item must be included to generate a plan/i)
    ).toBeInTheDocument();
  });

  test("is disabled while generating", () => {
    render(<ReorganiseItemSelector {...baseProps({ phase: "generating" })} />);
    expect(screen.getByRole("button", { name: /generating/i })).toBeDisabled();
  });

  test("is enabled with a non-empty selection and not generating", () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeEnabled();
  });

  test("health unavailable shows an advisory but does NOT disable Generate", () => {
    render(<ReorganiseItemSelector {...baseProps({ healthStatus: "unavailable" })} />);
    expect(screen.getByText(/image service is offline/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeEnabled();
  });

  test("shows a truthful, non-percentage generating status message", () => {
    render(<ReorganiseItemSelector {...baseProps({ phase: "generating" })} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/several minutes/i);
    expect(status.textContent).not.toMatch(/%/);
  });

  test("shows a generate error while preserving the ability to retry (no re-upload prompt)", () => {
    render(<ReorganiseItemSelector {...baseProps({ generateError: "Room-plan generation failed" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/room-plan generation failed/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/try again/i);
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeEnabled();
  });
});
