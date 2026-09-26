import { render, screen, within } from "@testing-library/react";
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
    expect(screen.getAllByRole("button", { name: /^detection/i })).toHaveLength(2);
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
    expect(screen.queryByRole("button", { name: /^detection/i })).not.toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  test("Show all boxes off with an active item renders only that item's box", () => {
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002" })];
    render(<AnalysedRoomPanel {...baseProps({ items, showAllBoxes: false, activeItemId: "item_002" })} />);

    const boxes = screen.getAllByRole("button", { name: /^detection/i });
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

  // Declutter never passes the getBoxClassName prop (every test above
  // renders without it and stays green
  // unmodified), proving the default preserves the exact original
  // Declutter coloring behaviour. This test proves a CALLER-supplied
  // classifier is actually used when Direct Reorganise (or any future
  // consumer) supplies one.
  test("a caller-supplied getBoxClassName overrides the default Declutter coloring", () => {
    const getBoxClassName = vi.fn(() => "custom-reorganise-box-class");
    render(<AnalysedRoomPanel {...baseProps({ items: [makeItem({ item_id: "item_001" })], getBoxClassName })} />);

    const box = screen.getByRole("button", { name: /detection 1/i });
    expect(box).toHaveClass("custom-reorganise-box-class");
    expect(getBoxClassName).toHaveBeenCalledWith(expect.objectContaining({ item_id: "item_001" }), false, false);
  });

  describe("analysed-room presentation and controls", () => {
    test("the only controls are the detection boxes, the Show all boxes checkbox and Expand image; no retake or crop", () => {
      render(<AnalysedRoomPanel {...baseProps()} />);
      expect(screen.getByRole("checkbox", { name: /show all boxes/i })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /^detection/i })).toHaveLength(1); // one box
      expect(screen.getByRole("button", { name: "Expand image" })).toBeInTheDocument();
      expect(screen.getAllByRole("button")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: /retake|camera|crop/i })).not.toBeInTheDocument();
    });

    test("Expand image opens the enlarged image with the same outlines, aligned by the same boxes, and closing returns focus", async () => {
      const user = userEvent.setup();
      const onBoxClick = vi.fn();
      const items = [
        makeItem({ item_id: "item_001", box: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.6 } }),
        makeItem({ item_id: "item_002", box: { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 } }),
      ];
      render(<AnalysedRoomPanel {...baseProps({ items, onBoxClick, showAllBoxes: true })} />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const trigger = screen.getByRole("button", { name: "Expand image" });
      await user.click(trigger);
      const dialog = screen.getByRole("dialog", { name: "Analysed space" });
      expect(dialog).toHaveAccessibleDescription(/show or hide the detected item outlines/i);
      expect(within(dialog).getByRole("img", { name: "The space photo you uploaded" })).toHaveAttribute("src", "blob:mock-preview");
      // Outlines are decorative in the enlarged view: no box buttons, but
      // one positioned outline per item, numbered like the panel's own.
      expect(within(dialog).queryByRole("button", { name: /^detection/i })).not.toBeInTheDocument();
      const outlines = within(dialog).getAllByTestId("lightbox-overlay");
      expect(outlines).toHaveLength(2);
      expect(outlines[0].style.left).toBe("10%");
      expect(outlines[0].style.width).toBe("20%");
      expect(outlines[0]).toHaveTextContent("1");
      expect(within(dialog).getByRole("checkbox", { name: "Show boxes" })).toBeChecked();
      await user.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(onBoxClick).not.toHaveBeenCalled();
    });

    test("the lightbox's Show boxes toggle starts from the panel's Show all boxes setting and never changes it", async () => {
      const user = userEvent.setup();
      const onToggleShowAllBoxes = vi.fn();
      render(<AnalysedRoomPanel {...baseProps({ showAllBoxes: false, onToggleShowAllBoxes })} />);
      await user.click(screen.getByRole("button", { name: "Expand image" }));
      const dialog = screen.getByRole("dialog", { name: "Analysed space" });
      const toggle = within(dialog).getByRole("checkbox", { name: "Show boxes" });
      expect(toggle).not.toBeChecked();
      expect(within(dialog).queryAllByTestId("lightbox-overlay")).toHaveLength(0);
      await user.click(toggle);
      expect(within(dialog).getAllByTestId("lightbox-overlay")).toHaveLength(1);
      expect(onToggleShowAllBoxes).not.toHaveBeenCalled();
    });

    test("no Expand image control when there is no image", () => {
      render(<AnalysedRoomPanel {...baseProps({ imageUrl: null })} />);
      expect(screen.queryByRole("button", { name: "Expand image" })).not.toBeInTheDocument();
    });

    test("the default classifier still distinguishes unresolved / contextual / resolved boxes", () => {
      const items = [
        makeItem({ item_id: "item_010", is_unresolved: true, is_expected: true }),
        makeItem({ item_id: "item_011", is_expected: false, is_unresolved: false }),
        makeItem({ item_id: "item_012", is_expected: true, is_unresolved: false, review_decision: "discard" }),
      ];
      render(<AnalysedRoomPanel {...baseProps({ items })} />);
      expect(screen.getByRole("button", { name: /detection 10/i }).className).toContain("border-dashed");
      expect(screen.getByRole("button", { name: /detection 11/i }).className).toContain("border-dotted");
      const resolved = screen.getByRole("button", { name: /detection 12/i }).className;
      expect(resolved).not.toContain("border-dashed");
      expect(resolved).not.toContain("border-dotted");
    });
  });
});
