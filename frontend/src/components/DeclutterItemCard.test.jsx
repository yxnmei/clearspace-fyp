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
    const TOKEN = { Keep: "keep", Sell: "sell", Donate: "donate", Discard: "discard" };
    const segmentOf = (radio) => radio.nextElementSibling; // the visible, peer-styled segment

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

    test("the four options are one cohesive control in a single row of four at every breakpoint", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      const track = screen.getByRole("radio", { name: "Keep" }).closest("label").parentElement;
      expect(track.className).toMatch(/\bgrid\b/);
      expect(track.className).toMatch(/\bgrid-cols-4\b/);
      expect(track.className).not.toMatch(/\bgrid-cols-2\b/);
      expect(track.querySelectorAll("label")).toHaveLength(4);
      expect(track.className).not.toMatch(/overflow-x-auto/);
    });

    test.each(["Keep", "Sell", "Donate", "Discard"])(
      "%s shows an icon, its text label and its decision colour token, never colour alone",
      (label) => {
        render(
          <DeclutterItemCard
            item={makeReviewItem({ review_decision: label.toLowerCase() })}
            onDecisionChange={vi.fn()}
            onExcludedChange={vi.fn()}
          />
        );
        const radio = screen.getByRole("radio", { name: label });
        const segment = segmentOf(radio);
        expect(segment.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
        expect(segment).toHaveTextContent(label);
        expect(segment.className).toMatch(new RegExp(`text-decision-${TOKEN[label]}`));
        expect(segment.className).toMatch(new RegExp(`border-decision-${TOKEN[label]}`));
        // no raw palette classes remain
        expect(segment.className).not.toMatch(/green|blue|amber|red-\d/);
      }
    );

    test.each(["Keep", "Sell", "Donate", "Discard"])(
      "the selected %s decision gets the stronger treatment; the rest stay neutral until hovered",
      (label) => {
        render(
          <DeclutterItemCard
            item={makeReviewItem({ review_decision: label.toLowerCase() })}
            onDecisionChange={vi.fn()}
            onExcludedChange={vi.fn()}
          />
        );
        const chosen = screen.getByRole("radio", { name: label });
        expect(chosen).toBeChecked();
        expect(segmentOf(chosen).className).toMatch(/\bbg-surface\b/);

        for (const other of ["Keep", "Sell", "Donate", "Discard"].filter((l) => l !== label)) {
          const seg = segmentOf(screen.getByRole("radio", { name: other })).className;
          expect(seg).toMatch(/border-transparent/);
          expect(seg).toMatch(/text-muted-foreground/);
          expect(seg).toMatch(new RegExp(`hover:text-decision-${TOKEN[other]}`));
          expect(seg).not.toMatch(new RegExp(`border-decision-${TOKEN[other]}`));
        }
      }
    );

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

    test("arrow keys move between the native radios and select, calling back with item_id", async () => {
      const user = userEvent.setup();
      const onDecisionChange = vi.fn();
      render(
        <DeclutterItemCard
          item={makeReviewItem({ item_id: "item_042", review_decision: "keep" })}
          onDecisionChange={onDecisionChange}
          onExcludedChange={vi.fn()}
        />
      );

      await user.tab();
      expect(screen.getByRole("radio", { name: "Keep" })).toHaveFocus();
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("radio", { name: "Sell" })).toHaveFocus();
      expect(onDecisionChange).toHaveBeenCalledWith("item_042", "sell");
    });

    test("the visible segment carries the keyboard focus ring for its hidden radio", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      for (const label of ["Keep", "Sell", "Donate", "Discard"]) {
        const radio = screen.getByRole("radio", { name: label });
        expect(radio.className).toMatch(/\bpeer\b/);
        expect(segmentOf(radio).className).toMatch(/peer-focus-visible:ring-2/);
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

  describe("compact row content", () => {
    test("hides raw item_id, detection confidence and item_validity from the visible row", () => {
      const { container } = render(
        <DeclutterItemCard
          item={makeReviewItem({ item_id: "item_007", confidence: 0.45, item_validity: "raw_valid" })}
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
        />
      );
      const text = container.textContent;
      expect(text).not.toMatch(/item_007|item_id/);
      expect(text).not.toMatch(/45\s*%|detection confidence/i);
      expect(text).not.toMatch(/%/);
      expect(text).not.toMatch(/raw_valid|validity/i);
      expect(container.querySelector("code")).toBeNull();
      // the number badge (derived from item_id) still links the row to its box
      expect(screen.getByText("7")).toBeInTheDocument();
    });

    test("keeps position and relative size as a concise disambiguation line", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      expect(screen.getByText("upper-left, small")).toBeInTheDocument();
    });

    test("the AI suggestion and reason stay present but secondary, with the decision's icon and name", () => {
      render(
        <DeclutterItemCard
          item={makeReviewItem({ ai_decision: "donate", ai_reason: "still usable by someone else" })}
          onDecisionChange={vi.fn()}
          onExcludedChange={vi.fn()}
        />
      );
      const line = screen.getByText(/AI suggests:/i).closest("p");
      expect(line).toHaveTextContent(/AI suggests: Donate, still usable by someone else/);
      expect(line.className).toMatch(/text-xs/);
      expect(line.className).toMatch(/text-muted-foreground/);
      expect(line.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    });
  });

  describe("responsive card grid", () => {
    const classesOf = (el) => el.className.split(/\s+/);

    test("is one CSS grid: two columns below md, three from md up, with no responsive hide/show duplicates", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      const grid = screen.getByTestId("item-card-grid");
      const classes = classesOf(grid);
      expect(classes).toContain("grid");
      expect(classes).toContain("grid-cols-[auto_minmax(0,1fr)]");
      expect(classes).toContain("md:grid-cols-[auto_minmax(0,1fr)_auto]");
      expect(grid.querySelector(".hidden, [class*='md:hidden'], [class*='sm:hidden']")).toBeNull();
    });

    test("the single DecisionControl spans both mobile columns on its own row, and moves to the right-hand column from md", () => {
      render(<DeclutterItemCard item={makeReviewItem()} onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />);
      const groups = screen.getAllByRole("group");
      expect(groups).toHaveLength(1); // one fieldset, one radio group
      expect(screen.getAllByRole("radio")).toHaveLength(4);
      const control = groups[0];
      expect(control.parentElement).toBe(screen.getByTestId("item-card-grid"));
      const classes = classesOf(control);
      // mobile: full card width beneath the thumbnail + info row
      for (const cls of ["col-span-2", "col-start-1", "row-start-2"]) expect(classes).toContain(cls);
      // desktop: third column, first row, right-aligned
      for (const cls of ["md:col-span-1", "md:col-start-3", "md:row-start-1", "md:justify-self-end"]) expect(classes).toContain(cls);
      // nothing inside clips a label
      expect(control.querySelector("[class*='overflow-hidden']")).toBeNull();
    });

    test("thumbnail and item info share the first row; the secondary lines follow on their own row", () => {
      render(
        <DeclutterItemCard item={makeReviewItem({ box: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 } })} imageUrl="blob:room" onDecisionChange={vi.fn()} onExcludedChange={vi.fn()} />
      );
      const thumb = screen.getByTestId("item-crop-thumbnail");
      for (const cls of ["col-start-1", "row-start-1"]) expect(classesOf(thumb)).toContain(cls);

      const info = screen.getByText("picture frame").closest("div");
      for (const cls of ["col-start-2", "row-start-1"]) expect(classesOf(info)).toContain(cls);

      const secondary = screen.getByText(/AI suggests:/i).closest("p").parentElement;
      for (const cls of ["col-span-2", "col-start-1", "row-start-3", "md:col-start-2", "md:row-start-2"]) {
        expect(classesOf(secondary)).toContain(cls);
      }
      expect(secondary).toContainElement(screen.getByRole("checkbox"));
      expect(secondary).toContainElement(screen.getByRole("button", { name: /wrong label/i }));
    });

    test("the grid changes nothing about identity or callbacks: item_id keys the group, exclusion and correction", async () => {
      const user = userEvent.setup();
      const onDecisionChange = vi.fn();
      const onExcludedChange = vi.fn();
      const onCorrectLabel = vi.fn();
      render(
        <DeclutterItemCard
          item={makeReviewItem({ item_id: "item_021", review_decision: null })}
          onDecisionChange={onDecisionChange}
          onExcludedChange={onExcludedChange}
          onCorrectLabel={onCorrectLabel}
        />
      );
      expect(screen.getByRole("radio", { name: "Keep" })).toHaveAttribute("name", "decision-item_021");
      await user.click(screen.getByRole("radio", { name: "Donate" }));
      expect(onDecisionChange).toHaveBeenCalledWith("item_021", "donate");
      await user.click(screen.getByRole("checkbox"));
      expect(onExcludedChange).toHaveBeenCalledWith("item_021", true);
      await user.click(screen.getByRole("button", { name: /wrong label/i }));
      await user.clear(screen.getByLabelText(/corrected label/i));
      await user.type(screen.getByLabelText(/corrected label/i), "poster");
      await user.click(screen.getByRole("button", { name: /submit correction/i }));
      expect(onCorrectLabel).toHaveBeenCalledWith("item_021", "poster");
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
      // no per-item <img> and no image role that would rival the one space photo
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
