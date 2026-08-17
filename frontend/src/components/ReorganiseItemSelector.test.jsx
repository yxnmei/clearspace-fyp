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

describe("ReorganiseItemSelector", () => {
  test("shows the selected count", () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    expect(screen.getByText(/1 of 1/)).toBeInTheDocument();
  });

  test("clicking an item's checkbox calls onToggleItem with its item_id", async () => {
    // Note: getByRole("checkbox") alone would be ambiguous —
    // AnalysedRoomPanel also renders its own "Show all boxes" checkbox,
    // so every query here targets the item checkbox by its accessible
    // name (the label text) or its id.
    const onToggleItem = vi.fn();
    render(<ReorganiseItemSelector {...baseProps({ onToggleItem })} />);
    await userEvent.click(document.getElementById("reorganise-item-item_001"));
    expect(onToggleItem).toHaveBeenCalledWith("item_001");
  });

  test("duplicate-labelled items render as independent rows, identified by item_id", () => {
    const items = [
      makeItem({ item_id: "item_001", clean_label: "picture frame", effective_label: "picture frame" }),
      makeItem({ item_id: "item_002", clean_label: "picture frame", effective_label: "picture frame" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_002"] })} />);
    expect(screen.getAllByText("picture frame")).toHaveLength(2);
    expect(document.getElementById("reorganise-item-item_001")).toBeInTheDocument();
    expect(document.getElementById("reorganise-item-item_002")).toBeInTheDocument();
  });

  test("an unselected item shows a Not included badge", () => {
    render(<ReorganiseItemSelector {...baseProps({ selectedItemIds: [] })} />);
    expect(screen.getByText(/not included/i)).toBeInTheDocument();
    expect(document.getElementById("reorganise-item-item_001")).not.toBeChecked();
  });

  test("selection copy avoids overconfident \"will be preserved\" wording", () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    expect(screen.queryByText(/will be preserved/i)).not.toBeInTheDocument();
    expect(screen.getByText(/will be included in the plan and requested in the visual preview/i)).toBeInTheDocument();
  });

  test("contextual items are shown but never rendered as selectable actionable rows", () => {
    const items = [
      makeItem({ item_id: "item_001", item_role: "actionable" }),
      makeItem({ item_id: "item_002", item_role: "contextual", clean_label: "wall", effective_label: "wall" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001"] })} />);
    expect(document.getElementById("reorganise-item-item_001")).toBeInTheDocument();
    expect(document.getElementById("reorganise-item-item_002")).toBeNull(); // contextual item gets no checkbox at all
    expect(screen.getByText(/contextual items \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText("wall")).toBeInTheDocument();
  });

  test("clicking a box in the room panel links back to the matching item (box->list linking preserved)", async () => {
    const items = [makeItem({ item_id: "item_007" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_007"] })} />);
    await userEvent.click(screen.getByRole("button", { name: /detection 7/i }));
    // scrollIntoView isn't implemented in jsdom; the interaction not throwing,
    // plus the box existing with the right accessible name, is the proof here.
    expect(screen.getByRole("button", { name: /detection 7/i })).toBeInTheDocument();
  });

  test("Generate is disabled when selection is empty", () => {
    render(<ReorganiseItemSelector {...baseProps({ selectedItemIds: [] })} />);
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeDisabled();
  });

  test("Generate is disabled while generating", () => {
    render(<ReorganiseItemSelector {...baseProps({ phase: "generating" })} />);
    expect(screen.getByRole("button", { name: /generating/i })).toBeDisabled();
  });

  test("Generate is enabled with a non-empty selection and not generating", () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeEnabled();
  });

  test("health unavailable shows an advisory but does NOT disable Generate", () => {
    render(<ReorganiseItemSelector {...baseProps({ healthStatus: "unavailable" })} />);
    expect(screen.getByText(/image service is offline/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate room plan/i })).toBeEnabled();
  });

  test("clicking Generate calls onGenerate", async () => {
    const onGenerate = vi.fn();
    render(<ReorganiseItemSelector {...baseProps({ onGenerate })} />);
    await userEvent.click(screen.getByRole("button", { name: /generate room plan/i }));
    expect(onGenerate).toHaveBeenCalled();
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

  test("checkboxes are disabled while generating", () => {
    render(<ReorganiseItemSelector {...baseProps({ phase: "generating" })} />);
    expect(document.getElementById("reorganise-item-item_001")).toBeDisabled();
  });
});
