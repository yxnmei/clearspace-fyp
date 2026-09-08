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
    ...overrides,
  };
}

describe("ReorganiseItemSelector review screen", () => {
  test("shows all actionable detections as included by default", () => {
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_002"] })} />);

    expect(screen.getByRole("heading", { name: /review items for your room plan/i })).toBeInTheDocument();
    expect(screen.getByText(/all 2 actionable detections are included by default/i)).toBeInTheDocument();
    expect(screen.getByText(/2 of 2 included/i)).toBeInTheDocument();
  });

  test("uses include/exclude language and never frames the task as decluttering", () => {
    const items = [
      makeItem({ item_id: "item_001" }),
      makeItem({ item_id: "item_002", clean_label: "chair", effective_label: "chair" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001"] })} />);

    expect(screen.getByText("Included in plan")).toBeInTheDocument();
    expect(screen.getByText("Excluded from plan")).toBeInTheDocument();
    expect(screen.queryByText(/choose what to keep/i)).not.toBeInTheDocument();
  });

  test("clicking an actionable checkbox calls onToggleItem with item_id", async () => {
    const onToggleItem = vi.fn();
    render(<ReorganiseItemSelector {...baseProps({ onToggleItem })} />);

    await userEvent.click(document.getElementById("reorganise-item-item_001"));
    expect(onToggleItem).toHaveBeenCalledWith("item_001");
  });

  test("duplicate-labelled items remain independent by item_id", () => {
    const items = [
      makeItem({ item_id: "item_001", effective_label: "picture frame" }),
      makeItem({ item_id: "item_002", effective_label: "picture frame" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_002"] })} />);

    expect(screen.getAllByText("picture frame")).toHaveLength(2);
    expect(document.getElementById("reorganise-item-item_001")).toBeInTheDocument();
    expect(document.getElementById("reorganise-item-item_002")).toBeInTheDocument();
  });

  test("contextual detections are visible but not selectable", () => {
    const items = [
      makeItem(),
      makeItem({ item_id: "item_002", item_role: "contextual", effective_label: "wall" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items })} />);

    expect(screen.getByText(/contextual items \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/shown for context and not included in the plan/i)).toBeInTheDocument();
    expect(document.getElementById("reorganise-item-item_002")).toBeNull();
  });

  test("clicking an image box links to its matching row", async () => {
    const items = [makeItem({ item_id: "item_007" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_007"] })} />);

    await userEvent.click(screen.getByRole("button", { name: /detection 7/i }));
    expect(screen.getByRole("button", { name: /detection 7/i })).toBeInTheDocument();
  });

  test("disables selection while another workflow operation owns the screen", () => {
    render(<ReorganiseItemSelector {...baseProps({ selectionDisabled: true })} />);
    expect(document.getElementById("reorganise-item-item_001")).toBeDisabled();
  });
});
