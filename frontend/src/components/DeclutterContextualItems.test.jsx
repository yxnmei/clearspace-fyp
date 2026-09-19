import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterContextualItems from "./DeclutterContextualItems";

function makeItem(overrides = {}) {
  return {
    item_id: "item_099",
    clean_label: "wall",
    position: "center",
    relative_size: "large",
    is_expected: false,
    label_source: "detector",
    effective_label: "wall",
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    items: [makeItem()],
    activeItemId: null,
    registerItemRef: vi.fn(),
    activateItem: vi.fn(),
    deactivateItem: vi.fn(),
    ...overrides,
  };
}

describe("DeclutterContextualItems", () => {
  test("is visibly secondary and states it carries no Declutter decision", () => {
    render(<DeclutterContextualItems {...baseProps()} />);
    expect(screen.getByRole("heading", { name: /contextual items \(1\)/i })).toBeInTheDocument();
    expect(screen.getByText(/detected for context only, not sent for a declutter decision/i)).toBeInTheDocument();
  });

  test("offers no decision controls and no label correction", () => {
    render(<DeclutterContextualItems {...baseProps()} />);
    expect(screen.getByText("wall")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /wrong label/i })).not.toBeInTheDocument();
  });

  test("entries are still overlay-linkable, ref registered, activates on hover, marked aria-current", async () => {
    const user = userEvent.setup();
    const registerItemRef = vi.fn();
    const activateItem = vi.fn();
    const { rerender } = render(
      <DeclutterContextualItems {...baseProps({ registerItemRef, activateItem })} />
    );
    expect(registerItemRef).toHaveBeenCalledWith("item_099", expect.any(HTMLElement));

    await user.hover(screen.getByText("wall").closest("li"));
    expect(activateItem).toHaveBeenCalledWith("item_099");

    rerender(<DeclutterContextualItems {...baseProps({ registerItemRef, activateItem, activeItemId: "item_099" })} />);
    expect(screen.getByText("wall").closest("li")).toHaveAttribute("aria-current", "true");
  });

  test("shows the effective label when the item was corrected", () => {
    render(
      <DeclutterContextualItems {...baseProps({ items: [makeItem({ clean_label: "box", effective_label: "hoodie" })] })} />
    );
    expect(screen.getByText("hoodie")).toBeInTheDocument();
    expect(screen.queryByText("box")).not.toBeInTheDocument();
  });

  test("keeps the number badge and location but hides raw item_id, confidence and validity", () => {
    const { container } = render(
      <DeclutterContextualItems {...baseProps({ items: [makeItem({ item_id: "item_099", confidence: 0.9, item_validity: null })] })} />
    );
    const row = screen.getByText("wall").closest("li");
    expect(within(row).getByText("99")).toBeInTheDocument();
    expect(row).toHaveTextContent(/center, large/);
    expect(container.textContent).not.toMatch(/item_099|item_id|%|validity|confidence|double check/i);
    expect(container.querySelector("code")).toBeNull();
  });
});
