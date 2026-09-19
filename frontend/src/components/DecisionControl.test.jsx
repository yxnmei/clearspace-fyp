import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import DecisionControl, { DECISION_OPTIONS, DECISION_OPTIONS_BY_VALUE } from "./DecisionControl";

const LABELS = ["Keep", "Sell", "Donate", "Discard"];
const segmentOf = (radio) => radio.nextElementSibling;

describe("DecisionControl", () => {
  test("renders the four decisions as native radios in one per-item group, in a fieldset with an item-specific legend", () => {
    render(<DecisionControl itemId="item_004" itemLabel="lamp" value="keep" onChange={vi.fn()} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.value)).toEqual(["keep", "sell", "donate", "discard"]);
    radios.forEach((r) => {
      expect(r.tagName).toBe("INPUT");
      expect(r).toHaveAttribute("name", "decision-item_004");
    });
    expect(screen.getByRole("group", { name: "Your decision for lamp" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("reflects the current value as the single checked radio, and none when the value is null", () => {
    const { rerender } = render(<DecisionControl itemId="item_1" itemLabel="lamp" value="donate" onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Donate" })).toBeChecked();
    expect(screen.getAllByRole("radio").filter((r) => r.checked)).toHaveLength(1);

    rerender(<DecisionControl itemId="item_1" itemLabel="lamp" value={null} onChange={vi.fn()} />);
    expect(screen.getAllByRole("radio").filter((r) => r.checked)).toHaveLength(0);
  });

  test.each([
    ["Keep", "keep"],
    ["Sell", "sell"],
    ["Donate", "donate"],
    ["Discard", "discard"],
  ])("clicking %s calls onChange(itemId, %s) with the unchanged decision value", async (label, value) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DecisionControl itemId="item_042" itemLabel="lamp" value={null} onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: label }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("item_042", value);
  });

  test("keyboard: Tab lands on the checked radio and arrow keys move the selection through the group", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // A stateful host, as the pages are: the hook stores the new decision
    // and re-renders the control with it.
    function Host() {
      const [value, setValue] = useState("sell");
      return (
        <DecisionControl
          itemId="item_9"
          itemLabel="lamp"
          value={value}
          onChange={(itemId, next) => {
            onChange(itemId, next);
            setValue(next);
          }}
        />
      );
    }
    render(<Host />);

    await user.tab();
    expect(screen.getByRole("radio", { name: "Sell" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Donate" })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("item_9", "donate");

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Sell" })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("item_9", "sell");
  });

  test("two controls for duplicate labels stay independent because the group name comes from item_id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <DecisionControl itemId="item_004" itemLabel="picture frame" value="keep" onChange={onChange} />
        <DecisionControl itemId="item_006" itemLabel="picture frame" value="keep" onChange={onChange} />
      </>
    );
    const keeps = screen.getAllByRole("radio", { name: "Keep" });
    expect(keeps[0]).toHaveAttribute("name", "decision-item_004");
    expect(keeps[1]).toHaveAttribute("name", "decision-item_006");

    await user.click(screen.getAllByRole("radio", { name: "Sell" })[1]);
    expect(onChange).toHaveBeenCalledWith("item_006", "sell");
    expect(onChange).not.toHaveBeenCalledWith("item_004", "sell");
  });

  test.each(LABELS)("%s always shows an icon, its text and its decision colour token (colour is never the only cue)", (label) => {
    render(<DecisionControl itemId="i" itemLabel="lamp" value={label.toLowerCase()} onChange={vi.fn()} />);
    const segment = segmentOf(screen.getByRole("radio", { name: label }));
    expect(segment.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(segment).toHaveTextContent(label);
    expect(segment.className).toMatch(new RegExp(`text-decision-${label.toLowerCase()}`));
  });

  test("the hidden radio is a peer and the visible segment carries the focus ring and disabled styling", () => {
    render(<DecisionControl itemId="i" itemLabel="lamp" value="keep" onChange={vi.fn()} />);
    const radio = screen.getByRole("radio", { name: "Keep" });
    expect(radio.className).toMatch(/\bsr-only\b/);
    expect(radio.className).toMatch(/\bpeer\b/);
    const segment = segmentOf(radio);
    expect(segment.className).toMatch(/peer-focus-visible:ring-2/);
    expect(segment.className).toMatch(/peer-disabled:opacity-50/);
  });

  test("lays all four options out in one row at every breakpoint: full-width four-column grid on mobile, natural-width inline grid from sm up", () => {
    render(<DecisionControl itemId="i" itemLabel="lamp" value="keep" onChange={vi.fn()} />);
    const track = screen.getByRole("radio", { name: "Keep" }).closest("label").parentElement;
    const classes = track.className.split(/\s+/);
    expect(classes).toContain("grid");
    expect(classes).toContain("w-full");
    expect(classes).toContain("grid-cols-4");
    expect(classes).not.toContain("grid-cols-2");
    expect(classes).not.toContain("sm:grid-cols-4"); // four columns already at base, nothing to switch to
    expect(classes).toContain("sm:inline-grid");
    expect(classes).toContain("sm:w-auto");
    expect(classes).toContain("max-w-full");
    // nothing is ever clipped or scrolled: the host card gives the control room instead
    expect(classes).not.toContain("overflow-hidden");
    expect(track.className).not.toMatch(/overflow-/);
    // all four segments are direct cells of that one track, in order
    const cells = Array.from(track.children);
    expect(cells).toHaveLength(4);
    expect(cells.map((cell) => cell.querySelector("input").value)).toEqual(["keep", "sell", "donate", "discard"]);
  });

  test("uses compact 11px single-line segments on mobile and restores text-xs with roomier spacing from sm up, at a 40px touch height", () => {
    render(<DecisionControl itemId="i" itemLabel="lamp" value="keep" onChange={vi.fn()} />);
    const track = screen.getByRole("radio", { name: "Keep" }).closest("label").parentElement;
    const trackClasses = track.className.split(/\s+/);
    for (const cls of ["gap-0.5", "p-0.5", "sm:gap-1", "sm:p-1"]) expect(trackClasses).toContain(cls);

    for (const label of LABELS) {
      const segment = segmentOf(screen.getByRole("radio", { name: label }));
      const classes = segment.className.split(/\s+/);
      expect(classes).toContain("min-h-10");
      expect(classes).not.toContain("min-h-11");
      for (const cls of ["gap-0.5", "px-1", "py-1", "text-[11px]", "whitespace-nowrap", "min-w-0"]) expect(classes).toContain(cls);
      expect(classes).not.toContain("overflow-hidden");
      for (const cls of ["sm:gap-1.5", "sm:px-2", "sm:py-1.5", "sm:text-xs"]) expect(classes).toContain(cls);
      // icon + visible label on every segment, icon slightly smaller on mobile
      const icon = segment.querySelector('svg[aria-hidden="true"]');
      expect(icon.getAttribute("class")).toMatch(/\bh-3\b/);
      expect(icon.getAttribute("class")).toMatch(/\bsm:h-3\.5\b/);
      expect(segment).toHaveTextContent(label);
    }
  });

  test("exports the shared option metadata used by the summary bar", () => {
    expect(DECISION_OPTIONS.map((o) => o.value)).toEqual(["keep", "sell", "donate", "discard"]);
    for (const option of DECISION_OPTIONS) {
      expect(option.Icon).toBeTruthy(); // a Lucide icon component (forwardRef object)
      expect(option.text).toBe(`text-decision-${option.value}`);
      expect(DECISION_OPTIONS_BY_VALUE[option.value]).toBe(option);
    }
  });
});
