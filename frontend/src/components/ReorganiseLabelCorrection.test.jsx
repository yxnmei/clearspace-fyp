import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ReorganiseLabelCorrection from "./ReorganiseLabelCorrection";
import ReorganiseItemSelector from "./ReorganiseItemSelector";
import { applyLabelCorrections } from "../lib/reorganiseLabelCorrections";

function makeItem(overrides = {}) {
  return {
    item_id: "item_001",
    clean_label: "rope",
    corrected_label: null,
    effective_label: "rope",
    label_source: "detector",
    box: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 },
    confidence: 0.8,
    position: "upper-left",
    relative_size: "small",
    item_role: "actionable",
    ...overrides,
  };
}

function renderControl(props = {}) {
  const onCorrectLabel = vi.fn();
  const onClearCorrection = vi.fn();
  render(
    <ReorganiseLabelCorrection
      item={makeItem()}
      onCorrectLabel={onCorrectLabel}
      onClearCorrection={onClearCorrection}
      {...props}
    />
  );
  return { onCorrectLabel, onClearCorrection };
}

const openButton = (name = /wrong label\? correct it for item 1, rope/i) => screen.getByRole("button", { name });

describe("ReorganiseLabelCorrection", () => {
  test("starts collapsed behind an item-specific accessible button", () => {
    renderControl();
    expect(openButton()).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("opening focuses a labelled input prefilled with the current label and shows the detector label", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(openButton());

    const input = screen.getByRole("textbox", { name: "Corrected label for item 1" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("rope");
    expect(input).toHaveAttribute("maxlength", "80");
    expect(input).toHaveAccessibleDescription(/detected as rope\./i);
  });

  test("saving calls onCorrectLabel with the item_id and trimmed label, then returns focus", async () => {
    const user = userEvent.setup();
    const { onCorrectLabel } = renderControl();

    await user.click(openButton());
    const input = screen.getByRole("textbox", { name: /corrected label/i });
    await user.clear(input);
    await user.type(input, "  charger  {Enter}");

    expect(onCorrectLabel).toHaveBeenCalledTimes(1);
    expect(onCorrectLabel).toHaveBeenCalledWith("item_001", "charger");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(openButton()).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Item 1 is now labelled charger.");
  });

  test("a blank label is rejected with an accessible error and no callback", async () => {
    const user = userEvent.setup();
    const { onCorrectLabel } = renderControl();

    await user.click(openButton());
    const input = screen.getByRole("textbox", { name: /corrected label/i });
    await user.clear(input);
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Save label" }));

    expect(onCorrectLabel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a label.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/enter a label\./i);
  });

  test("saving the unchanged label closes without a callback", async () => {
    const user = userEvent.setup();
    const { onCorrectLabel } = renderControl();
    await user.click(openButton());
    await user.click(screen.getByRole("button", { name: "Save label" }));
    expect(onCorrectLabel).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("Cancel and Escape close without a callback", async () => {
    const user = userEvent.setup();
    const { onCorrectLabel } = renderControl();

    await user.click(openButton());
    await user.type(screen.getByRole("textbox", { name: /corrected label/i }), "x");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(openButton());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(openButton()).toHaveFocus();
    expect(onCorrectLabel).not.toHaveBeenCalled();
  });

  test("a corrected item offers Use detected label, which clears by item_id", async () => {
    const user = userEvent.setup();
    const { onClearCorrection } = renderControl({
      item: makeItem({ corrected_label: "charger", effective_label: "charger", label_source: "user" }),
    });

    await user.click(screen.getByRole("button", { name: /edit corrected label for item 1, charger/i }));
    await user.click(screen.getByRole("button", { name: "Use detected label" }));

    expect(onClearCorrection).toHaveBeenCalledWith("item_001");
    expect(screen.getByRole("status")).toHaveTextContent("Item 1 is back to its detected label, rope.");
  });

  test("warns that saving clears an existing plan", async () => {
    const user = userEvent.setup();
    renderControl({ planExists: true });
    await user.click(openButton());
    expect(screen.getByRole("textbox", { name: /corrected label/i })).toHaveAccessibleDescription(
      /saving a new label clears your current tidy plan/i
    );
  });

  test("is disabled while a plan is being created", () => {
    renderControl({ disabled: true });
    expect(openButton()).toBeDisabled();
  });
});

// A small stateful harness around the real selector: selection and
// corrections are held separately, exactly as useReorganiseFlow does.
function SelectorHarness({ initialItems, onToggleSpy = () => {}, onCorrectSpy = () => {} }) {
  const [selected, setSelected] = useState(initialItems.map((item) => item.item_id));
  const [corrections, setCorrections] = useState({});
  return (
    <ReorganiseItemSelector
      items={applyLabelCorrections(initialItems, corrections)}
      selectedItemIds={selected}
      onToggleItem={(itemId) => {
        onToggleSpy(itemId);
        setSelected((prev) => (prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]));
      }}
      imageUrl="blob:mock-preview"
      onCorrectLabel={(itemId, label) => {
        onCorrectSpy(itemId, label);
        setCorrections((prev) => ({ ...prev, [itemId]: label }));
      }}
      onClearLabelCorrection={(itemId) =>
        setCorrections((prev) => {
          const next = { ...prev };
          delete next[itemId];
          return next;
        })
      }
    />
  );
}

const checkboxFor = (itemId) => document.getElementById(`reorganise-item-${itemId}`);
const cardFor = (itemId) => checkboxFor(itemId).closest("li");

describe("ReorganiseItemSelector with label correction", () => {
  test("clicking, typing and pressing Enter in the correction never toggles selection", async () => {
    const user = userEvent.setup();
    const onToggleSpy = vi.fn();
    render(<SelectorHarness initialItems={[makeItem()]} onToggleSpy={onToggleSpy} />);

    await user.click(within(cardFor("item_001")).getByRole("button", { name: /wrong label/i }));
    const input = screen.getByRole("textbox", { name: /corrected label for item 1/i });
    await user.click(input);
    await user.clear(input);
    await user.type(input, "charger ");
    await user.keyboard("{Enter}");

    expect(onToggleSpy).not.toHaveBeenCalled();
    expect(checkboxFor("item_001")).toBeChecked();
    // The correction control is not inside the checkbox's <label>.
    expect(input.closest("label")).toBeNull();
    expect(within(cardFor("item_001")).getByRole("button", { name: /edit corrected label/i }).closest("label")).toBeNull();
  });

  test("a correction on an excluded item keeps it excluded", async () => {
    const user = userEvent.setup();
    render(<SelectorHarness initialItems={[makeItem()]} />);
    await user.click(checkboxFor("item_001"));
    expect(checkboxFor("item_001")).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: /wrong label/i }));
    const input = screen.getByRole("textbox", { name: /corrected label/i });
    await user.clear(input);
    await user.type(input, "charger{Enter}");

    expect(checkboxFor("item_001")).not.toBeChecked();
    expect(within(cardFor("item_001")).getByText("Excluded")).toBeInTheDocument();
  });

  test("the corrected label shows in the row and the photo-box label, with the detector label kept", async () => {
    const user = userEvent.setup();
    render(<SelectorHarness initialItems={[makeItem()]} />);

    await user.click(screen.getByRole("button", { name: /wrong label/i }));
    const input = screen.getByRole("textbox", { name: /corrected label/i });
    await user.clear(input);
    await user.type(input, "charger{Enter}");

    const card = cardFor("item_001");
    expect(within(card).getByText("charger")).toBeInTheDocument();
    expect(within(card).getByText("Corrected")).toBeInTheDocument();
    expect(within(card).getByText("Detected as rope")).toBeInTheDocument();
    expect(checkboxFor("item_001")).toHaveAccessibleName(/charger/);
    expect(screen.getByRole("button", { name: "Detection 1: charger" })).toBeInTheDocument();
  });

  test("duplicate labels are corrected independently by item_id", async () => {
    const user = userEvent.setup();
    const onCorrectSpy = vi.fn();
    const lamps = [
      makeItem({ item_id: "item_001", clean_label: "lamp", effective_label: "lamp" }),
      makeItem({ item_id: "item_002", clean_label: "lamp", effective_label: "lamp", position: "lower-right" }),
    ];
    render(<SelectorHarness initialItems={lamps} onCorrectSpy={onCorrectSpy} />);

    await user.click(screen.getByRole("button", { name: /wrong label\? correct it for item 2, lamp/i }));
    const input = screen.getByRole("textbox", { name: "Corrected label for item 2" });
    await user.clear(input);
    await user.type(input, "desk fan{Enter}");

    expect(onCorrectSpy).toHaveBeenCalledWith("item_002", "desk fan");
    expect(screen.getByRole("button", { name: "Detection 1: lamp" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Detection 2: desk fan" })).toBeInTheDocument();
    expect(within(cardFor("item_001")).queryByText("Corrected")).not.toBeInTheDocument();
  });

  test("contextual items get no correction control", () => {
    render(
      <SelectorHarness
        initialItems={[makeItem(), makeItem({ item_id: "item_002", clean_label: "rug", effective_label: "rug", item_role: "contextual" })]}
      />
    );
    expect(screen.getAllByRole("button", { name: /wrong label/i })).toHaveLength(1);
  });

  test("without onCorrectLabel the selector renders no correction controls", () => {
    render(
      <ReorganiseItemSelector items={[makeItem()]} selectedItemIds={["item_001"]} onToggleItem={() => {}} imageUrl={null} />
    );
    expect(screen.queryByRole("button", { name: /wrong label/i })).not.toBeInTheDocument();
  });

  test("correction stays available while selection is locked on a finished plan", () => {
    render(
      <ReorganiseItemSelector
        items={[makeItem()]}
        selectedItemIds={["item_001"]}
        onToggleItem={() => {}}
        imageUrl={null}
        selectionDisabled
        onCorrectLabel={() => {}}
        planExists
      />
    );
    expect(checkboxFor("item_001")).toBeDisabled();
    expect(screen.getByRole("button", { name: /wrong label/i })).toBeEnabled();
  });
});
