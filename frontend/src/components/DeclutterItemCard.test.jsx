import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DeclutterItemCard from "./DeclutterItemCard";

function makeReviewItem(overrides = {}) {
  const cleanLabel = overrides.clean_label ?? "picture frame";
  return {
    item_id: "item_001",
    raw_phrase: "picture frame painting",
    clean_label: cleanLabel,
    position: "upper-left",
    relative_size: "small",
    confidence: 0.45,
    ai_decision: "discard",
    ai_reason: "duplicate, low confidence",
    item_validity: "raw_valid",
    is_expected: true,
    is_unresolved: false,
    review_decision: "discard",
    review_excluded: false,
    review_user_reason: null,
    decision_changed: false,
    has_decision_override: false,
    corrected_label: null,
    label_source: "detector",
    effective_label: cleanLabel,
    ...overrides,
  };
}

describe("DeclutterItemCard", () => {
  test("clicking a decision calls onDecisionChange with the item's item_id", async () => {
    const user = userEvent.setup();
    const onDecisionChange = vi.fn();
    render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={onDecisionChange} onExcludedChange={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "Keep" }));

    expect(onDecisionChange).toHaveBeenCalledWith("item_001", "keep");
  });

  test("toggling exclusion calls onExcludedChange with the item's item_id", async () => {
    const user = userEvent.setup();
    const onExcludedChange = vi.fn();
    render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={onExcludedChange} />);

    await user.click(screen.getByRole("checkbox"));

    expect(onExcludedChange).toHaveBeenCalledWith("item_001", true);
  });

  test("shows Changed and Excluded indicators when applicable", () => {
    render(
      <DeclutterItemCard
        item={makeReviewItem({ decision_changed: true, review_excluded: true })}
        onDecisionChange={vi.fn()}
        onExcludedChange={vi.fn()}
      />
    );
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(screen.getByText("Excluded")).toBeInTheDocument();
  });

  test("does not show Changed/Excluded indicators when not applicable", () => {
    render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
    expect(screen.queryByText("Changed")).not.toBeInTheDocument();
    expect(screen.queryByText("Excluded")).not.toBeInTheDocument();
  });

  test("the current review_decision is shown as selected", () => {
    render(<DeclutterItemCard item={makeReviewItem({ review_decision: "donate" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Donate" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Keep" })).not.toBeChecked();
  });

  test("decision controls are keyboard-focusable native radio inputs", async () => {
    // Native <input type="radio"> groups only put the CHECKED member in
    // the tab sequence (the others are reachable by arrow keys once the
    // group has focus), this is real browser/jsdom radio semantics, not
    // a limitation of the component. review_decision is "discard" here,
    // so that's the one Tab lands on first.
    const user = userEvent.setup();
    render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);

    await user.tab();

    expect(screen.getByRole("radio", { name: "Discard" })).toHaveFocus();
  });

  test("shows a visible item number badge derived from item_id", () => {
    render(<DeclutterItemCard item={makeReviewItem({ item_id: "item_012" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  test("hovering the card calls onActivate; leaving calls onDeactivate", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    render(
      <DeclutterItemCard
        item={makeReviewItem()}
        onDecisionChange={vi.fn()}
        onExcludedChange={vi.fn()}
        onActivate={onActivate}
        onDeactivate={onDeactivate}
      />
    );

    await user.hover(screen.getByText("picture frame"));
    expect(onActivate).toHaveBeenCalled();

    await user.unhover(screen.getByText("picture frame"));
    expect(onDeactivate).toHaveBeenCalled();
  });

  test("focusing a control inside the card calls onActivate; focusing away calls onDeactivate", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    render(
      <div>
        <DeclutterItemCard
          item={makeReviewItem()}
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
          onActivate={onActivate}
          onDeactivate={onDeactivate}
        />
        <button type="button">outside</button>
      </div>
    );

    await user.tab(); // focuses the checked radio inside the card
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onDeactivate).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "outside" }).focus(); // focus leaves the card entirely
    expect(onDeactivate).toHaveBeenCalled();
  });

  test("isActive renders an aria-current marker for the overlay to key off of", () => {
    const { rerender } = render(
      <DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} isActive={false} />
    );
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");

    rerender(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} isActive={true} />);
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "true");
  });

  test("registerRef is called with the item's item_id and the DOM node on mount, and with null on unmount", () => {
    const registerRef = vi.fn();
    const { unmount } = render(
      <DeclutterItemCard item={makeReviewItem({ item_id: "item_005" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} registerRef={registerRef} />
    );

    expect(registerRef).toHaveBeenCalledWith("item_005", expect.any(HTMLElement));

    unmount();

    expect(registerRef).toHaveBeenCalledWith("item_005", null);
  });

  test("displays effective_label, not clean_label, when the item has been corrected", () => {
    render(
      <DeclutterItemCard
        item={makeReviewItem({ clean_label: "box", corrected_label: "hoodie", label_source: "user", effective_label: "hoodie" })}
        onDecisionChange={vi.fn()}
        onExcludedChange={vi.fn()}
      />
    );
    expect(screen.getByText("hoodie")).toBeInTheDocument();
    expect(screen.queryByText("box")).not.toBeInTheDocument();
  });

  test("shows a Corrected by you badge only when label_source is user", () => {
    const { rerender } = render(
      <DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />
    );
    expect(screen.queryByText("Corrected by you")).not.toBeInTheDocument();

    rerender(
      <DeclutterItemCard
        item={makeReviewItem({ corrected_label: "hoodie", label_source: "user", effective_label: "hoodie" })}
        onDecisionChange={vi.fn()}
        onExcludedChange={vi.fn()}
      />
    );
    expect(screen.getByText("Corrected by you")).toBeInTheDocument();
  });

  describe("label correction control", () => {
    test("opening the form submits item_id plus the trimmed label", async () => {
      const user = userEvent.setup();
      const onCorrectLabel = vi.fn();
      render(
        <DeclutterItemCard item={makeReviewItem({ item_id: "item_004" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} onCorrectLabel={onCorrectLabel} />
      );

      await user.click(screen.getByRole("button", { name: /wrong label/i }));
      const input = screen.getByLabelText(/corrected label/i);
      await user.clear(input);
      await user.type(input, "  hoodie  ");
      await user.click(screen.getByRole("button", { name: /submit correction/i }));

      expect(onCorrectLabel).toHaveBeenCalledWith("item_004", "hoodie");
    });

    test("a blank label cannot be submitted", async () => {
      const user = userEvent.setup();
      const onCorrectLabel = vi.fn();
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} onCorrectLabel={onCorrectLabel} />);

      await user.click(screen.getByRole("button", { name: /wrong label/i }));
      const input = screen.getByLabelText(/corrected label/i);
      await user.clear(input);

      expect(screen.getByRole("button", { name: /submit correction/i })).toBeDisabled();
      expect(onCorrectLabel).not.toHaveBeenCalled();
    });

    test("the toggle button is disabled while correctionDisabled is true", () => {
      render(
        <DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} correctionDisabled={true} />
      );
      expect(screen.getByRole("button", { name: /wrong label/i })).toBeDisabled();
    });

    test("duplicate submission is disabled while this item is being corrected, and the pending state is accessible", async () => {
      const user = userEvent.setup();
      render(
        <DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} isCorrecting={true} />
      );

      await user.click(screen.getByRole("button", { name: /wrong label/i }));

      expect(screen.getByRole("button", { name: /correcting/i })).toBeDisabled();
      expect(screen.getByLabelText(/corrected label/i)).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent(/correcting label/i);
    });

    test("an item-local failure is shown accessibly without losing the entered correction", async () => {
      const user = userEvent.setup();
      render(
        <DeclutterItemCard
          item={makeReviewItem()}
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
          correctionError="Label correction failed"
        />
      );

      await user.click(screen.getByRole("button", { name: /wrong label/i }));
      const input = screen.getByLabelText(/corrected label/i);
      await user.clear(input);
      await user.type(input, "hoodie");

      expect(screen.getByRole("alert")).toHaveTextContent("Label correction failed");
      expect(input).toHaveValue("hoodie"); // not cleared by the error
    });

    test("cancel closes the form without submitting", async () => {
      const user = userEvent.setup();
      const onCorrectLabel = vi.fn();
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} onCorrectLabel={onCorrectLabel} />);

      await user.click(screen.getByRole("button", { name: /wrong label/i }));
      await user.click(screen.getByRole("button", { name: /cancel/i }));

      expect(screen.queryByLabelText(/corrected label/i)).not.toBeInTheDocument();
      expect(onCorrectLabel).not.toHaveBeenCalled();
    });
  });

  describe("segmented decision controls", () => {
    const CATEGORY = {
      Keep: { on: /border-green-600/, off: /border-green-200/, accent: /accent-green-600/ },
      Sell: { on: /border-blue-600/, off: /border-blue-200/, accent: /accent-blue-600/ },
      Donate: { on: /border-amber-600/, off: /border-amber-200/, accent: /accent-amber-600/ },
      Discard: { on: /border-red-600/, off: /border-red-200/, accent: /accent-red-600/ },
    };

    test("stay native radios inside the fieldset, not tabs or div buttons", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      const radios = screen.getAllByRole("radio");
      expect(radios).toHaveLength(4);
      radios.forEach((r) => expect(r.tagName).toBe("INPUT"));
      expect(radios[0].closest("fieldset")).not.toBeNull();
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
      // exactly one checked value across the four
      expect(radios.filter((r) => r.checked)).toHaveLength(1);
    });

    test.each([
      ["Keep", "green"],
      ["Sell", "blue"],
      ["Donate", "amber"],
      ["Discard", "red"],
    ])("%s uses its %s category colour (radio accent + label border/text/hover)", (label, colour) => {
      render(
        <DeclutterItemCard
          item={makeReviewItem({ review_decision: null })}
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
        />
      );
      const radio = screen.getByRole("radio", { name: label });
      const segment = radio.closest("label").className;
      // unselected: light category border, category text, matching hover
      expect(segment).toMatch(CATEGORY[label].off);
      expect(segment).toMatch(new RegExp(`text-${colour}-800`));
      expect(segment).toMatch(new RegExp(`hover:bg-${colour}-50`));
      // colour is not the only cue, the visible label text is still there
      expect(radio.closest("label")).toHaveTextContent(label);
      // the native radio accent carries the same category colour
      expect(radio.className).toMatch(CATEGORY[label].accent);
    });

    test.each([
      ["Keep", "green"],
      ["Sell", "blue"],
      ["Donate", "amber"],
      ["Discard", "red"],
    ])("the selected %s decision gets the stronger %s treatment; the rest stay light", (label, colour) => {
      render(
        <DeclutterItemCard
          item={makeReviewItem({ review_decision: label.toLowerCase() })}
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
        />
      );
      const chosen = screen.getByRole("radio", { name: label });
      expect(chosen).toBeChecked();
      const chosenSegment = chosen.closest("label").className;
      expect(chosenSegment).toMatch(CATEGORY[label].on); // stronger category border
      expect(chosenSegment).toMatch(new RegExp(`bg-${colour}-50`)); // tinted background

      for (const other of ["Keep", "Sell", "Donate", "Discard"].filter((l) => l !== label)) {
        const seg = screen.getByRole("radio", { name: other }).closest("label").className;
        expect(seg).toMatch(CATEGORY[other].off);
        expect(seg).not.toMatch(CATEGORY[other].on);
      }
    });

    test.each([
      ["Keep", "keep"],
      ["Sell", "sell"],
      ["Donate", "donate"],
      ["Discard", "discard"],
    ])("clicking %s still calls onDecisionChange(item_id, %s)", async (label, decision) => {
      const user = userEvent.setup();
      const onDecisionChange = vi.fn();
      render(
        <DeclutterItemCard
          item={makeReviewItem({ item_id: "item_042", review_decision: null })}
          onDecisionChange={onDecisionChange}
          onExcludedChange={vi.fn()}
        />
      );

      await user.click(screen.getByRole("radio", { name: label }));

      expect(onDecisionChange).toHaveBeenCalledWith("item_042", decision);
    });

    test("each radio keeps a visible keyboard focus ring", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      for (const label of ["Keep", "Sell", "Donate", "Discard"]) {
        expect(screen.getByRole("radio", { name: label }).className).toMatch(/focus-visible:ring-2/);
      }
    });

    test("the radio group name is derived from item_id, so duplicate labels stay independent", () => {
      const { rerender } = render(
        <DeclutterItemCard item={makeReviewItem({ item_id: "item_004" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />
      );
      expect(screen.getByRole("radio", { name: "Keep" })).toHaveAttribute("name", "decision-item_004");

      rerender(
        <DeclutterItemCard item={makeReviewItem({ item_id: "item_006" })} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />
      );
      expect(screen.getByRole("radio", { name: "Keep" })).toHaveAttribute("name", "decision-item_006");
    });

    test("exactly one checkbox (exclusion), no extra toggles were introduced", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    });

    test("status badges use real state, not invented metadata", () => {
      render(
        <DeclutterItemCard
          item={makeReviewItem({ decision_changed: true, review_excluded: true, label_source: "user", effective_label: "hoodie" })}
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
        />
      );
      expect(screen.getByText("Corrected by you")).toBeInTheDocument();
      expect(screen.getByText("Changed")).toBeInTheDocument();
      expect(screen.getByText("Excluded")).toBeInTheDocument();
      expect(screen.getByText(/AI suggests:/i)).toBeInTheDocument();
    });
  });

  describe("compact row thumbnail (Phase 5A)", () => {
    test("a decorative crop thumbnail is derived from the shared image + item box, not an <img>, not a control", () => {
      render(
        <DeclutterItemCard
          item={makeReviewItem({ box: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 } })}
          imageUrl="blob:room-abc"
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
        />
      );
      const thumb = screen.getByTestId("item-crop-thumbnail");
      expect(thumb).toHaveAttribute("aria-hidden", "true"); // row already names the item
      expect(thumb.style.backgroundImage).toBe('url("blob:room-abc")');
      // no per-item <img> and no image role that would rival the one room photo
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(thumb.querySelector("img")).toBeNull();
    });

    test("falls back to a neutral placeholder when no source image is available", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      expect(screen.getByTestId("item-crop-fallback")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    test("the thumbnail does not push a focusable element ahead of the decision radios", async () => {
      const user = userEvent.setup();
      render(
        <DeclutterItemCard
          item={makeReviewItem()}
          imageUrl="blob:room"
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
        />
      );
      await user.tab();
      expect(screen.getByRole("radio", { name: "Discard" })).toHaveFocus();
    });
  });
});
