import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterUnresolvedItems from "./DeclutterUnresolvedItems";

function makeItem(overrides = {}) {
  return {
    item_id: "item_003",
    clean_label: "cable",
    position: "center",
    relative_size: "small",
    is_expected: true,
    is_unresolved: true,
    label_source: "detector",
    effective_label: "cable",
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
    correctingItemId: null,
    correctionDisabled: false,
    correctionErrorFor: () => null,
    correctLabel: vi.fn(),
    ...overrides,
  };
}

describe("DeclutterUnresolvedItems", () => {
  test("stays prominent and explains that it blocks confirmation", () => {
    render(<DeclutterUnresolvedItems {...baseProps()} />);
    expect(screen.getByRole("heading", { name: /unresolved items \(1\)/i })).toBeInTheDocument();
    expect(screen.getByText(/confirmation is blocked until every item is resolved/i)).toBeInTheDocument();
    expect(screen.getByText(/no valid ai decision was produced for this item/i)).toBeInTheDocument();
  });

  test("shows the effective label and a Corrected by you badge only for user-corrected items", () => {
    const { rerender } = render(<DeclutterUnresolvedItems {...baseProps()} />);
    expect(screen.getByText("cable")).toBeInTheDocument();
    expect(screen.queryByText("Corrected by you")).not.toBeInTheDocument();

    rerender(
      <DeclutterUnresolvedItems
        {...baseProps({ items: [makeItem({ label_source: "user", effective_label: "charger" })] })}
      />
    );
    expect(screen.getByText("charger")).toBeInTheDocument();
    expect(screen.getByText("Corrected by you")).toBeInTheDocument();
  });

  test("registers each entry's ref and activates it on hover", async () => {
    const user = userEvent.setup();
    const registerItemRef = vi.fn();
    const activateItem = vi.fn();
    render(<DeclutterUnresolvedItems {...baseProps({ registerItemRef, activateItem })} />);

    expect(registerItemRef).toHaveBeenCalledWith("item_003", expect.any(HTMLElement));

    await user.hover(screen.getByText("cable").closest("li"));
    expect(activateItem).toHaveBeenCalledWith("item_003");
  });

  test("the active entry is marked aria-current for the overlay", () => {
    render(<DeclutterUnresolvedItems {...baseProps({ activeItemId: "item_003" })} />);
    expect(screen.getByText("cable").closest("li")).toHaveAttribute("aria-current", "true");
  });

  test("the correction control submits the right item_id and trimmed label", async () => {
    const user = userEvent.setup();
    const correctLabel = vi.fn();
    render(<DeclutterUnresolvedItems {...baseProps({ correctLabel })} />);

    await user.click(screen.getByRole("button", { name: /wrong label/i }));
    const input = screen.getByLabelText(/corrected label/i);
    await user.clear(input);
    await user.type(input, "  charger  ");
    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(correctLabel).toHaveBeenCalledWith("item_003", "charger");
  });

  test("a scoped correction error appears only for its own item", async () => {
    const user = userEvent.setup();
    const items = [makeItem({ item_id: "item_003" }), makeItem({ item_id: "item_009", clean_label: "wire", effective_label: "wire" })];
    render(
      <DeclutterUnresolvedItems
        {...baseProps({
          items,
          correctionErrorFor: (id) => (id === "item_003" ? "Label correction failed" : null),
        })}
      />
    );

    for (const btn of screen.getAllByRole("button", { name: /wrong label/i })) {
      await user.click(btn);
    }

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Label correction failed");
  });

  test("every correction control is disabled while any correction is in flight", () => {
    const items = [makeItem({ item_id: "item_003" }), makeItem({ item_id: "item_009" })];
    render(<DeclutterUnresolvedItems {...baseProps({ items, correctingItemId: "item_003", correctionDisabled: true })} />);

    const toggles = screen.getAllByRole("button", { name: /wrong label/i });
    expect(toggles).toHaveLength(2);
    toggles.forEach((b) => expect(b).toBeDisabled());
  });
});
