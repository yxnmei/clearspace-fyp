import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import StorageSuggestions from "./StorageSuggestions";

const IDEAS = [
  {
    name: "Dedicated display area",
    reason: "Use one deliberate display area for the painting and 6 picture frame items instead of scattering them.",
    related_item_ids: ["item_001"],
  },
  {
    name: "Desktop accessory organiser",
    reason: "Keep the keyboard and mouse together between uses so they are always at hand.",
    related_item_ids: ["item_002"],
  },
  { name: "Toy container", reason: "Give both toy items one easy place to return to after use.", related_item_ids: ["item_003"] },
];

const list = () => screen.getByRole("list", { name: /storage and organisation ideas/i });
const cards = () => within(list()).getAllByRole("listitem");
const classes = (el) => el.className.split(/\s+/).filter(Boolean);

describe("StorageSuggestions layout contract", () => {
  test("renders nothing at all without suggestions", () => {
    const { container } = render(<StorageSuggestions storageSuggestions={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(render(<StorageSuggestions storageSuggestions={null} />).container).toBeEmptyDOMElement();
  });

  test("one suggestion: a single column at every width, so the card uses the section's width", () => {
    render(<StorageSuggestions storageSuggestions={IDEAS.slice(0, 1)} />);
    expect(cards()).toHaveLength(1);
    const cls = classes(list());
    expect(cls).toContain("grid");
    expect(cls).toContain("grid-cols-1");
    expect(cls).not.toContain("sm:grid-cols-2");
    expect(cls).not.toContain("lg:grid-cols-3");
    expect(cls.some((c) => /grid-cols-[2-9]/.test(c))).toBe(false);
    // no per-card hack does the stretching: the grid itself is one column
    expect(classes(cards()[0])).not.toEqual(expect.arrayContaining([expect.stringMatching(/col-span|w-full/)]));
  });

  test.each([
    ["two", 2],
    ["three", 3],
  ])("%s suggestions: one column on phones, two from sm, three from lg", (_, count) => {
    render(<StorageSuggestions storageSuggestions={IDEAS.slice(0, count)} />);
    expect(cards()).toHaveLength(count);
    const cls = classes(list());
    expect(cls).toContain("grid");
    expect(cls).toContain("grid-cols-1");
    expect(cls).toContain("sm:grid-cols-2");
    expect(cls).toContain("lg:grid-cols-3");
    for (const card of cards()) expect(classes(card)).toContain("min-w-0");
  });

  test("the card markup, content and order are the same whatever the count", () => {
    for (const count of [1, 2, 3]) {
      const { unmount } = render(<StorageSuggestions storageSuggestions={IDEAS.slice(0, count)} />);
      expect(screen.getByRole("heading", { level: 3, name: "Storage and organisation ideas" })).toBeInTheDocument();
      expect(screen.getByText("Optional ways to give related items a consistent home.")).toBeInTheDocument();
      expect(cards().map((card) => Array.from(card.querySelectorAll("p")).map((p) => p.textContent))).toEqual(
        IDEAS.slice(0, count).map((s) => [s.name, s.reason])
      );
      expect(list().textContent).not.toMatch(/For:|item_00\d/);
      unmount();
    }
  });
});
