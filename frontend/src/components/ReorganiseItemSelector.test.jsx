import { act, render, screen, within } from "@testing-library/react";
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

const checkboxFor = (itemId) => document.getElementById(`reorganise-item-${itemId}`);
// item checkboxes only, excluding the analysed-room panel's own "Show all boxes" toggle
const itemCheckboxes = () => Array.from(document.querySelectorAll('input[type="checkbox"][id^="reorganise-item-"]'));
const cardFor = (itemId) => checkboxFor(itemId).closest("li");
const summaryText = () => screen.getByLabelText(/selection summary/i).textContent.replace(/\s+/g, " ");

describe("ReorganiseItemSelector, Select items screen", () => {
  test("introduces the screen as choosing items for a tidy plan, never a spatial plan or declutter", () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    expect(screen.getByRole("heading", { name: "Choose items for your tidy plan" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Remove incorrect detections or items you don't want considered. Keep desks or shelves if you want the plan to account for them."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/spatial|floor plan|choose what to keep|declutter/i)).not.toBeInTheDocument();
  });

  test("every actionable item renders exactly one checkbox, starting from the supplied selection", () => {
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002" }), makeItem({ item_id: "item_003" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_003"] })} />);

    expect(itemCheckboxes()).toHaveLength(3);
    expect(checkboxFor("item_001")).toBeChecked();
    expect(checkboxFor("item_002")).not.toBeChecked();
    expect(checkboxFor("item_003")).toBeChecked();
    for (const id of ["item_001", "item_002", "item_003"]) {
      expect(within(cardFor(id)).getAllByRole("checkbox")).toHaveLength(1);
    }
  });

  test("the summary counts detected, included and excluded from actionable items only", () => {
    const items = [
      makeItem({ item_id: "item_001" }),
      makeItem({ item_id: "item_002", effective_label: "chair" }),
      makeItem({ item_id: "item_003", effective_label: "rug" }),
      makeItem({ item_id: "item_090", item_role: "contextual", effective_label: "wall" }),
      makeItem({ item_id: "item_091", item_role: "contextual", effective_label: "window" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_003"] })} />);

    expect(summaryText()).toMatch(/3 detected/);
    expect(summaryText()).toMatch(/2 included/);
    expect(summaryText()).toMatch(/1 excluded/);
    expect(screen.getByLabelText(/selection summary/i).tagName).toBe("DL");
    expect(screen.queryByText(/5 detected/)).not.toBeInTheDocument();
  });

  test("zero included items shows a visible helper explaining that at least one item is needed", () => {
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002" })];
    const { rerender } = render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: [] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Include at least one item to continue to your tidy plan.");
    expect(summaryText()).toMatch(/0 included/);

    rerender(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_002"] })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("clicking the card label toggles the right item_id exactly once, and only that item", async () => {
    const user = userEvent.setup();
    const onToggleItem = vi.fn();
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002", effective_label: "chair" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_002"], onToggleItem })} />);

    await user.click(screen.getByText("chair"));
    expect(onToggleItem).toHaveBeenCalledTimes(1);
    expect(onToggleItem).toHaveBeenCalledWith("item_002");
  });

  test("clicking the checkbox itself toggles the right item_id exactly once", async () => {
    const user = userEvent.setup();
    const onToggleItem = vi.fn();
    render(<ReorganiseItemSelector {...baseProps({ onToggleItem })} />);
    await user.click(checkboxFor("item_001"));
    expect(onToggleItem).toHaveBeenCalledTimes(1);
    expect(onToggleItem).toHaveBeenCalledWith("item_001");
  });

  test("the checkbox is keyboard operable: Tab reaches it and Space toggles the item_id", async () => {
    const user = userEvent.setup();
    const onToggleItem = vi.fn();
    render(<ReorganiseItemSelector {...baseProps({ onToggleItem })} />);
    // Tab order: Show all boxes -> the overlay box button -> Expand image -> the item checkbox
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(checkboxFor("item_001")).toHaveFocus();
    await user.keyboard(" ");
    expect(onToggleItem).toHaveBeenCalledTimes(1);
    expect(onToggleItem).toHaveBeenCalledWith("item_001");
    expect(checkboxFor("item_001").className).toMatch(/focus-visible:ring-2/);
  });

  test("disabled selection cannot invoke the callback from the checkbox or the card", async () => {
    const user = userEvent.setup();
    const onToggleItem = vi.fn();
    render(<ReorganiseItemSelector {...baseProps({ onToggleItem, selectionDisabled: true })} />);
    expect(checkboxFor("item_001")).toBeDisabled();
    await user.click(checkboxFor("item_001"));
    await user.click(screen.getByText("lamp"));
    expect(onToggleItem).not.toHaveBeenCalled();
  });

  test("duplicate-labelled items remain independent by item_id, and only they show position and size", () => {
    const items = [
      makeItem({ item_id: "item_001", effective_label: "picture frame", position: "upper-left", relative_size: "small" }),
      makeItem({ item_id: "item_002", effective_label: "picture frame", position: "lower-right", relative_size: "medium" }),
      makeItem({ item_id: "item_003", effective_label: "lamp", position: "center", relative_size: "large" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_002", "item_003"] })} />);

    expect(screen.getAllByText("picture frame")).toHaveLength(2);
    expect(within(cardFor("item_001")).getByText("upper-left, small")).toBeInTheDocument();
    expect(within(cardFor("item_002")).getByText("lower-right, medium")).toBeInTheDocument();
    // a unique label needs no disambiguation
    expect(within(cardFor("item_003")).queryByText(/center|large/)).not.toBeInTheDocument();
    // secondary text only, never inside the label text itself
    expect(within(cardFor("item_001")).getByText("upper-left, small").className).toMatch(/text-xs/);
  });

  test("never shows raw item ids, confidence percentages or internal values", () => {
    const items = [makeItem({ item_id: "item_001", confidence: 0.81 }), makeItem({ item_id: "item_002", item_role: "contextual", effective_label: "wall", confidence: 0.4 })];
    const { container } = render(<ReorganiseItemSelector {...baseProps({ items })} />);
    expect(container.textContent).not.toMatch(/item_00\d|item_id|\d+\s*%|confidence|actionable|item_role/i);
    expect(container.querySelector("code")).toBeNull();
    // the number badge derived from item_id keeps the row linked to its box
    expect(within(cardFor("item_001")).getByText("1")).toBeInTheDocument();
  });

  test("each actionable card has one thumbnail, its label, and explicit Included or Excluded text with an icon", () => {
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002", effective_label: "chair" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001"] })} />);

    const included = cardFor("item_001");
    const excluded = cardFor("item_002");
    expect(within(included).getAllByTestId("item-crop-thumbnail")).toHaveLength(1);
    expect(within(excluded).getAllByTestId("item-crop-thumbnail")).toHaveLength(1);
    expect(within(included).getByText("lamp")).toBeInTheDocument();
    expect(within(excluded).getByText("chair")).toBeInTheDocument();

    const includedPill = within(included).getByText("Included");
    const excludedPill = within(excluded).getByText("Excluded");
    expect(includedPill.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(excludedPill.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(within(included).queryByText("Excluded")).not.toBeInTheDocument();
    expect(within(excluded).queryByText("Included")).not.toBeInTheDocument();
  });

  test("selected and excluded cards use distinct visual states on top of the text", () => {
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002", effective_label: "chair" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001"] })} />);

    const included = cardFor("item_001");
    const excluded = cardFor("item_002");
    expect(included).toHaveAttribute("data-selected", "true");
    expect(excluded).toHaveAttribute("data-selected", "false");
    expect(included.className).toMatch(/border-primary/);
    expect(excluded.className).not.toMatch(/border-primary/);
    expect(excluded.className).toMatch(/bg-surface-muted/);
    expect(within(included).getByText("Included").className).toMatch(/bg-accent/);
    expect(within(excluded).getByText("Excluded").className).toMatch(/text-muted-foreground/);
    expect(within(excluded).getByTestId("item-crop-thumbnail").className).toMatch(/grayscale/);
    // no raw palette classes anywhere on the cards
    expect(included.className + excluded.className).not.toMatch(/green-|stone-/);
  });

  test("the whole card is the checkbox label and a comfortable target", () => {
    render(<ReorganiseItemSelector {...baseProps()} />);
    const label = cardFor("item_001").querySelector("label");
    expect(label).toHaveAttribute("for", "reorganise-item-item_001");
    expect(label).toContainElement(checkboxFor("item_001"));
    expect(label).toContainElement(screen.getByText("lamp"));
    expect(label.className).toMatch(/\bmin-h-14\b/);
    expect(checkboxFor("item_001").className).toMatch(/\bh-5\b/);
  });

  test("contextual items are shown in a compact secondary section, are not selectable, and show no ids", () => {
    const items = [
      makeItem(),
      makeItem({ item_id: "item_002", item_role: "contextual", effective_label: "wall" }),
    ];
    render(<ReorganiseItemSelector {...baseProps({ items })} />);

    const section = screen.getByRole("region", { name: /contextual items \(1\)/i });
    expect(within(section).getByText(/shown for context and not included in the plan/i)).toBeInTheDocument();
    expect(within(section).getByText("wall")).toBeInTheDocument();
    expect(within(section).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(checkboxFor("item_002")).toBeNull();
    expect(section.textContent).not.toMatch(/item_002|item_id|%/);
    expect(itemCheckboxes()).toHaveLength(1);
  });

  test("clicking an image box focuses the matching card, and the card links back to its box by item_id", async () => {
    const user = userEvent.setup();
    const items = [makeItem({ item_id: "item_007" }), makeItem({ item_id: "item_008", effective_label: "chair" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_007", "item_008"] })} />);

    await user.click(screen.getByRole("button", { name: /detection 7/i }));
    expect(cardFor("item_007")).toHaveFocus();
    expect(cardFor("item_007")).toHaveAttribute("aria-current", "true");
    expect(cardFor("item_008")).not.toHaveAttribute("aria-current");
  });

  test("hovering a card highlights its box; leaving clears it", async () => {
    const user = userEvent.setup();
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002", effective_label: "chair" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001"] })} />);

    await user.hover(cardFor("item_002"));
    expect(screen.getByRole("button", { name: /detection 2/i })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /detection 1/i })).not.toHaveAttribute("aria-current");
    // included vs excluded boxes stay visually distinct, with tokens
    expect(screen.getByRole("button", { name: /detection 1/i }).className).toMatch(/border-primary/);
    expect(screen.getByRole("button", { name: /detection 2/i }).className).toMatch(/border-dashed/);

    await user.unhover(cardFor("item_002"));
    expect(screen.getByRole("button", { name: /detection 2/i })).not.toHaveAttribute("aria-current");
  });

  test("Show all boxes stays on by default and can be toggled to show only the active box", async () => {
    const user = userEvent.setup();
    const items = [makeItem({ item_id: "item_001" }), makeItem({ item_id: "item_002", effective_label: "chair" })];
    render(<ReorganiseItemSelector {...baseProps({ items, selectedItemIds: ["item_001", "item_002"] })} />);

    const toggle = screen.getByRole("checkbox", { name: /show all boxes/i });
    expect(toggle).toBeChecked();
    expect(screen.getAllByRole("button", { name: /detection \d/i })).toHaveLength(2);

    await user.click(toggle);
    expect(screen.queryAllByRole("button", { name: /detection \d/i })).toHaveLength(0);
    await user.hover(cardFor("item_002"));
    expect(screen.getAllByRole("button", { name: /detection \d/i })).toHaveLength(1);
  });

  test("Back to top mounts with its sentinels when enabled, and appears once the top scrolls away", () => {
    const observers = [];
    const originalIO = global.IntersectionObserver;
    global.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    };
    try {
      const { container } = render(<ReorganiseItemSelector {...baseProps()} enableBackToTop />);
      expect(container.querySelectorAll('span[aria-hidden="true"].h-px')).toHaveLength(2);
      expect(screen.queryByRole("button", { name: /back to top/i })).not.toBeInTheDocument();
      act(() => observers[0].callback([{ isIntersecting: false }]));
      expect(screen.getByRole("button", { name: /back to top/i })).toBeInTheDocument();
    } finally {
      global.IntersectionObserver = originalIO;
    }
  });

  test("layout: preview first and stacked on mobile, sticky preview beside a single-column list from lg, no overflow classes", () => {
    const { container } = render(<ReorganiseItemSelector {...baseProps()} />);
    const columns = container.querySelector(".lg\\:flex-row");
    expect(columns.className).toMatch(/\bflex-col\b/);
    expect(columns.firstElementChild.className).toMatch(/lg:sticky/);
    expect(columns.firstElementChild).toContainElement(screen.getByRole("checkbox", { name: /show all boxes/i }));
    expect(columns.lastElementChild).toContainElement(checkboxFor("item_001"));
    expect(columns.lastElementChild.className).toMatch(/\bmin-w-0\b/);
    const list = cardFor("item_001").parentElement;
    expect(list.className).toMatch(/space-y-2/);
    expect(list.className).not.toMatch(/grid-cols/);
    expect(container.innerHTML).not.toMatch(/overflow-x-auto|whitespace-nowrap|w-screen/);
  });

  test("no selection interaction triggers anything but onToggleItem", async () => {
    const user = userEvent.setup();
    const onToggleItem = vi.fn();
    const { container } = render(<ReorganiseItemSelector {...baseProps({ onToggleItem })} />);
    await user.click(checkboxFor("item_001"));
    await user.click(screen.getByRole("button", { name: /detection 1/i }));
    await user.hover(cardFor("item_001"));
    expect(onToggleItem).toHaveBeenCalledTimes(1);
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: /generate|tidy plan|continue/i })).not.toBeInTheDocument();
  });
});
