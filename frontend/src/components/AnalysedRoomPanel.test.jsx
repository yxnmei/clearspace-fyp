import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import AnalysedRoomPanel from "./AnalysedRoomPanel";

function makeItem(overrides = {}) {
  return {
    item_id: "item_001",
    clean_label: "lamp",
    box: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 },
    is_expected: true,
    is_unresolved: false,
    ai_decision: "keep",
    review_decision: "keep",
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    imageUrl: "blob:mock-preview",
    items: [makeItem()],
    activeItemId: null,
    onBoxClick: vi.fn(),
    showAllBoxes: true,
    onToggleShowAllBoxes: vi.fn(),
    ...overrides,
  };
}

describe("AnalysedRoomPanel", () => {
  test("renders the image and the detection limitation guidance", () => {
    render(<AnalysedRoomPanel {...baseProps()} />);
    expect(screen.getByRole("img", { name: /detected item outlines/i })).toHaveAttribute("src", "blob:mock-preview");
    expect(screen.getByText(/ai detection may miss or misidentify belongings/i)).toBeInTheDocument();
  });

  test("shows a fallback message instead of crashing when there is no image yet", () => {
    render(<AnalysedRoomPanel {...baseProps({ imageUrl: null })} />);
    expect(screen.getByText(/image preview unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("a normalized box renders at the correct percentage position and size", () => {
    render(
      <AnalysedRoomPanel
        {...baseProps({
          items: [makeItem({ box: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 } })],
        })}
      />
    );
    const box = screen.getByRole("button", { name: /detection 1/i });
    expect(box.style.left).toBe("10%");
    expect(box.style.top).toBe("20%");
    expect(box.style.width).toBe("40%"); // (0.5 - 0.1) * 100
    expect(box.style.height).toBe("40%"); // (0.6 - 0.2) * 100
  });

  test("two same-labelled items remain distinct boxes, keyed and identified by item_id", () => {
    const items = [
      makeItem({ item_id: "item_004", clean_label: "picture frame", box: { x1: 0.0, y1: 0.0, x2: 0.1, y2: 0.1 } }),
      makeItem({ item_id: "item_006", clean_label: "picture frame", box: { x1: 0.2, y1: 0.2, x2: 0.3, y2: 0.3 } }),
    ];
    render(<AnalysedRoomPanel {...baseProps({ items })} />);

    expect(screen.getByRole("button", { name: /detection 4: picture frame/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /detection 6: picture frame/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  test("every box shows a visible item number", () => {
    render(<AnalysedRoomPanel {...baseProps({ items: [makeItem({ item_id: "item_012" })] })} />);
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  test("clicking a box calls onBoxClick with that item's item_id", async () => {
    const user = userEvent.setup();
    const onBoxClick = vi.fn();
    render(<AnalysedRoomPanel {...baseProps({ items: [makeItem({ item_id: "item_007" })], onBoxClick })} />);

    await user.click(screen.getByRole("button", { name: /detection 7/i }));

    expect(onBoxClick).toHaveBeenCalledWith("item_007");
  });

  test("the active item's box is marked aria-current", () => {
    render(<AnalysedRoomPanel {...baseProps({ items: [makeItem({ item_id: "item_003" })], activeItemId: "item_003" })} />);
    expect(screen.getByRole("button", { name: /detection 3/i })).toHaveAttribute("aria-current", "true");
  });

  test("Show all boxes off with no active item renders no boxes, but does not remove the guidance/image", () => {
    render(<AnalysedRoomPanel {...baseProps({ showAllBoxes: false, activeItemId: null })} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  test("Show all boxes off with an active item renders only that item's box", () => {
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002" })];
    render(<AnalysedRoomPanel {...baseProps({ items, showAllBoxes: false, activeItemId: "item_002" })} />);

    const boxes = screen.getAllByRole("button");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toHaveAttribute("aria-label", expect.stringContaining("Detection 2"));
  });

  test("toggling Show all boxes calls the handler with the new value", async () => {
    const user = userEvent.setup();
    const onToggleShowAllBoxes = vi.fn();
    render(<AnalysedRoomPanel {...baseProps({ showAllBoxes: false, onToggleShowAllBoxes })} />);

    await user.click(screen.getByRole("checkbox", { name: /show all boxes/i }));

    expect(onToggleShowAllBoxes).toHaveBeenCalledWith(true);
  });

  test("unresolved and contextual items are visually distinguishable and carry no decision", () => {
    const items = [
      makeItem({ item_id: "item_010", is_expected: true, is_unresolved: true, ai_decision: null, review_decision: null }),
      makeItem({ item_id: "item_011", is_expected: false, is_unresolved: false, ai_decision: null, review_decision: null }),
      makeItem({ item_id: "item_012", is_expected: true, is_unresolved: false, ai_decision: "discard", review_decision: "discard" }),
    ];
    render(<AnalysedRoomPanel {...baseProps({ items })} />);

    const unresolvedBox = screen.getByRole("button", { name: /detection 10/i });
    const contextualBox = screen.getByRole("button", { name: /detection 11/i });
    const resolvedBox = screen.getByRole("button", { name: /detection 12/i });

    expect(unresolvedBox.className).toContain("border-dashed");
    expect(contextualBox.className).toContain("border-dotted");
    expect(resolvedBox.className).not.toContain("border-dashed");
    expect(resolvedBox.className).not.toContain("border-dotted");
    // Each box style is distinct from the other two, so all three
    // categories remain distinguishable purely from the rendered class.
    expect(unresolvedBox.className).not.toBe(contextualBox.className);
    expect(unresolvedBox.className).not.toBe(resolvedBox.className);
  });

  test("a corrected item's box accessible label shows effective_label, not clean_label", () => {
    render(
      <AnalysedRoomPanel
        {...baseProps({
          items: [makeItem({ item_id: "item_001", clean_label: "box", corrected_label: "hoodie", effective_label: "hoodie" })],
        })}
      />
    );
    expect(screen.getByRole("button", { name: /detection 1: hoodie/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /detection 1: box/i })).not.toBeInTheDocument();
  });

  test("an uncorrected item's box accessible label falls back to clean_label", () => {
    render(<AnalysedRoomPanel {...baseProps({ items: [makeItem({ item_id: "item_001", clean_label: "lamp" })] })} />);
    expect(screen.getByRole("button", { name: /detection 1: lamp/i })).toBeInTheDocument();
  });
});
