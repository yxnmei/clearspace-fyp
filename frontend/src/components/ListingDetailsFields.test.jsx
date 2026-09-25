import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ListingDetailsFields from "./ListingDetailsFields";

// jsdom does not lay anything out, so these pin the STRUCTURE that makes
// the two fields line up in a real browser: one shared header row class
// (explicit line heights and a minimum height, counter or not) and one
// shared control class (fixed height), in both the pre-generation variant
// and the compact variant used inside a generated listing card.

function renderFields(props = {}) {
  const onChange = vi.fn();
  render(
    <ListingDetailsFields
      itemId="item_001"
      itemLabel="lamp"
      details={{ listing_name: "lamp", condition: "not_specified" }}
      onChange={onChange}
      {...props}
    />
  );
  return { onChange };
}

describe.each([
  ["pre-generation", false],
  ["listing card (compact)", true],
])("ListingDetailsFields alignment, %s variant", (_name, compact) => {
  test("both labels sit in identical header rows and both controls share one height class", () => {
    renderFields({ compact });
    const [nameHeader, conditionHeader] = screen.getAllByTestId("listing-field-header");
    expect(nameHeader.className).toBe(conditionHeader.className);
    expect(nameHeader.className).toMatch(/\bmin-h-5\b/);
    expect(nameHeader.className).toMatch(/\bitems-end\b/);

    const nameLabel = screen.getByText("Listing name for lamp");
    const conditionLabel = screen.getByText("Condition for lamp");
    expect(nameLabel.className).toBe(conditionLabel.className);
    expect(nameLabel.className).toMatch(/\bleading-4\b/);

    const input = screen.getByLabelText("Listing name for lamp");
    const select = screen.getByLabelText("Condition for lamp");
    expect(input.className).toBe(select.className);
    expect(input.className).toMatch(/\bh-9\b/);
    expect(input.className).not.toMatch(/\bpy-1\b/);
  });

  test("the character counter is kept, in the name header only, with its own line height", () => {
    renderFields({ compact });
    const [nameHeader, conditionHeader] = screen.getAllByTestId("listing-field-header");
    const counter = screen.getByText("4/80");
    expect(nameHeader).toContainElement(counter);
    expect(conditionHeader).not.toContainElement(counter);
    expect(counter.className).toMatch(/\bleading-4\b/);
  });

  test("the fields stack below sm and sit side by side, top-aligned, from sm", () => {
    renderFields({ compact });
    const grid = screen.getAllByTestId("listing-field-header")[0].parentElement.parentElement;
    const classes = grid.className.split(/\s+/);
    expect(classes).toContain("grid");
    expect(classes).toContain("sm:items-start");
    expect(classes.some((c) => /^grid-cols-/.test(c))).toBe(false); // one column on phones
    expect(classes.some((c) => /^sm:grid-cols-/.test(c))).toBe(true);
  });
});

describe("ListingDetailsFields behaviour is unchanged", () => {
  test("typing a name and choosing a condition forward the same patches as before", async () => {
    const user = userEvent.setup();
    const { onChange } = renderFields();
    await user.type(screen.getByLabelText("Listing name for lamp"), "!");
    expect(onChange).toHaveBeenLastCalledWith("item_001", { listing_name: "lamp!" });
    await user.selectOptions(screen.getByLabelText("Condition for lamp"), "good");
    expect(onChange).toHaveBeenLastCalledWith("item_001", { condition: "good" });
  });

  test("an over-long name still turns the counter red", () => {
    renderFields({ details: { listing_name: "x".repeat(81), condition: "not_specified" } });
    expect(screen.getByText("81/80").className).toMatch(/text-error/);
  });
});
