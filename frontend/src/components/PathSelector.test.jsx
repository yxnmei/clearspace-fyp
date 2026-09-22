import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import PathSelector from "./PathSelector";

function renderSelector() {
  const onChoose = vi.fn();
  render(<PathSelector onChoose={onChoose} />);
  return { onChoose };
}

describe("PathSelector, radio group", () => {
  test("exposes exactly three workflow radios in one named group", () => {
    renderSelector();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.every((r) => r.getAttribute("name") === "workflow")).toBe(true);
    expect(screen.getByRole("radio", { name: "Declutter" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Reorganise" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Both" })).toBeInTheDocument();
  });

  test("the group is labelled", () => {
    renderSelector();
    // fieldset + <legend>Choose a workflow</legend>
    expect(screen.getByRole("group", { name: /choose a workflow/i })).toBeInTheDocument();
  });

  test("nothing is selected initially", () => {
    renderSelector();
    screen.getAllByRole("radio").forEach((r) => expect(r).not.toBeChecked());
  });

  test.each([
    ["Declutter", "declutter.svg"],
    ["Reorganise", "reorganise.svg"],
    ["Both", "both.svg"],
  ])("uses the bundled %s workflow illustration", (label, filename) => {
    renderSelector();
    const card = screen.getByRole("radio", { name: label }).closest("label");
    const icon = card.querySelector("img");
    expect(icon).toBeTruthy();
    expect(icon.getAttribute("src")).toContain(filename);
    expect(icon).toHaveAttribute("alt", "");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});

describe("PathSelector, select then continue", () => {
  test("Continue is disabled until a workflow is selected", async () => {
    const user = userEvent.setup();
    renderSelector();
    const continueButton = screen.getByRole("button", { name: /continue/i });
    expect(continueButton).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "Reorganise" }));
    expect(continueButton).toBeEnabled();
  });

  test("selecting a card marks it checked and visibly selected", async () => {
    const user = userEvent.setup();
    renderSelector();
    const declutter = screen.getByRole("radio", { name: "Declutter" });

    // the visual card is the radio's styled sibling <div>
    expect(declutter.nextElementSibling.className).not.toMatch(/bg-accent\/40/);

    await user.click(declutter);

    expect(declutter).toBeChecked();
    expect(declutter.nextElementSibling.className).toMatch(/bg-accent\/40/);
  });

  test("only one card can be selected at a time", async () => {
    const user = userEvent.setup();
    renderSelector();
    await user.click(screen.getByRole("radio", { name: "Declutter" }));
    await user.click(screen.getByRole("radio", { name: "Both" }));

    expect(screen.getByRole("radio", { name: "Declutter" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Both" })).toBeChecked();
  });

  test("Continue calls onChoose exactly once with the selected workflow value", async () => {
    const user = userEvent.setup();
    const { onChoose } = renderSelector();

    await user.click(screen.getByRole("radio", { name: "Reorganise" }));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("reorganise");
  });

  test.each([
    ["Declutter", "declutter"],
    ["Reorganise", "reorganise"],
    ["Both", "both"],
  ])("choosing %s passes %s to onChoose", async (label, value) => {
    const user = userEvent.setup();
    const { onChoose } = renderSelector();
    await user.click(screen.getByRole("radio", { name: label }));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onChoose).toHaveBeenCalledWith(value);
  });

  test("does not call onChoose from clicking a card alone", async () => {
    const user = userEvent.setup();
    const { onChoose } = renderSelector();
    await user.click(screen.getByRole("radio", { name: "Both" }));
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe("PathSelector, keyboard operation (native radio behaviour)", () => {
  test("Tab reaches the group and arrow keys select within it, then Continue is keyboard-activated", async () => {
    const user = userEvent.setup();
    const { onChoose } = renderSelector();

    await user.tab();
    expect(screen.getByRole("radio", { name: "Declutter" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    const reorganise = screen.getByRole("radio", { name: "Reorganise" });
    expect(reorganise).toBeChecked();

    await user.tab(); // out of the radio group, onto Continue
    expect(screen.getByRole("button", { name: /continue/i })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("reorganise");
  });
});

describe("PathSelector, honest copy", () => {
  const FEATURES = {
    Declutter: [
      "Get AI suggestions to Keep, Sell, Donate or Discard",
      "Review and adjust every decision",
      "Create editable listing drafts for items you choose to sell",
    ],
    Reorganise: [
      "Let AI identify items for your tidy plan",
      "Choose exactly which items to include",
      "Get a personalised checklist, storage ideas and an optional AI preview",
    ],
    Both: [
      "Get AI suggestions, then review and adjust every decision",
      "Create a tidy plan for kept items, with an optional AI preview",
      "Create editable listing drafts for items you choose to sell",
    ],
  };
  const card = (name) => screen.getByRole("radio", { name }).closest("label");
  const bullets = (name) => within(within(card(name)).getByRole("list")).getAllByRole("listitem");

  test("introduces every workflow as working with a space, not only a room", () => {
    renderSelector();
    expect(screen.getByText("Choose a workflow to declutter your space, reorganise it, or do both in one guided pass.")).toBeInTheDocument();
    for (const name of ["Declutter", "Reorganise", "Both"]) expect(card(name).textContent).not.toMatch(/\broom\b/i);
  });

  test.each(["Declutter", "Reorganise", "Both"])("%s renders one semantic list of exactly three bullets, in order, without full stops", (name) => {
    renderSelector();
    expect(within(card(name)).getAllByRole("list")).toHaveLength(1);
    const items = bullets(name);
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.textContent.trim())).toEqual(FEATURES[name]);
    for (const li of items) expect(li.textContent.trim()).not.toMatch(/\.$/);
  });

  test("the bullet list is the radio's accessible description, so the card is still announced with its features", () => {
    renderSelector();
    for (const name of ["Declutter", "Reorganise", "Both"]) {
      const radio = screen.getByRole("radio", { name });
      const list = within(card(name)).getByRole("list");
      expect(radio).toHaveAttribute("aria-describedby", list.id);
      expect(radio).toHaveAccessibleDescription(new RegExp(FEATURES[name][0]));
    }
  });

  test("the old paragraph descriptions are gone and no card gained another intro paragraph", () => {
    renderSelector();
    for (const name of ["Declutter", "Reorganise", "Both"]) {
      expect(card(name).querySelector("p")).toBeNull();
      expect(card(name)).not.toHaveTextContent(/included automatically|optionally review the list|confirm your declutter decisions first|review, change and confirm every decision yourself|server derives/i);
    }
    expect(screen.getAllByText(/choose a workflow to declutter your space/i)).toHaveLength(1);
  });

  test("every bullet says what the AI does or how the user stays in control, and each workflow's difference is stated", () => {
    renderSelector();
    expect(bullets("Declutter").map((li) => li.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/AI suggestions/), expect.stringMatching(/review and adjust/i)]));
    expect(bullets("Reorganise").map((li) => li.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/Let AI identify/), expect.stringMatching(/choose exactly which items/i)]));
    expect(bullets("Both").map((li) => li.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/tidy plan for kept items/), expect.stringMatching(/listing drafts/)]));
    expect(bullets("Reorganise").map((li) => li.textContent)).not.toEqual(bullets("Declutter").map((li) => li.textContent));
  });

  test("bullets are light markers beside left-aligned, wrapping text: no cards, chips or overflow inside the list", () => {
    renderSelector();
    for (const name of ["Declutter", "Reorganise", "Both"]) {
      const list = within(card(name)).getByRole("list");
      expect(list.className).toMatch(/\btext-left\b/);
      expect(list.className).toMatch(/\bspace-y-1\.5\b/);
      expect(list.className).not.toMatch(/whitespace-nowrap|overflow-x|truncate/);
      for (const li of bullets(name)) {
        expect(li.className).toMatch(/\bmin-w-0\b/);
        expect(li.className).not.toMatch(/rounded-card|border|shadow|bg-surface/);
        const marker = li.firstElementChild;
        expect(marker).toHaveAttribute("aria-hidden", "true");
        expect(marker.className).toMatch(/\bshrink-0\b/);
        expect(marker.className).toMatch(/\brounded-pill\b/);
        expect(li.lastElementChild.className).toMatch(/\bbreak-words\b/);
        expect(li.lastElementChild.className).toMatch(/\bmin-w-0\b/);
      }
    }
  });

  test("the 'Best for' footers are unchanged", () => {
    renderSelector();
    expect(card("Declutter")).toHaveTextContent("Best for quick item decisions");
    expect(card("Reorganise")).toHaveTextContent("Best for space planning");
    expect(card("Both")).toHaveTextContent("Best for full end-to-end guidance");
  });

  test("a short 'You're in control' reassurance is shown", () => {
    renderSelector();
    expect(screen.getByText(/you're in control/i)).toBeInTheDocument();
  });
});

describe("PathSelector, Recommended badge", () => {
  test("only the Both card carries a Recommended badge", () => {
    renderSelector();
    const badges = screen.getAllByText(/recommended/i);
    expect(badges).toHaveLength(1);
    const bothCard = screen.getByRole("radio", { name: "Both" }).closest("label");
    expect(within(bothCard).getByText(/recommended/i)).toBeInTheDocument();
  });
});

describe("PathSelector, responsive layout", () => {
  test("the selector fills its container up to the max-w-5xl content width", () => {
    const { container } = render(<PathSelector onChoose={vi.fn()} />);
    const section = container.querySelector("section");
    expect(section).toBeTruthy();
    expect(section.className).toMatch(/(^|\s)w-full(\s|$)/);
    expect(section.className).toMatch(/(^|\s)max-w-5xl(\s|$)/);
  });

  test("the card grid is one column by default and three across at the lg breakpoint", () => {
    const { container } = render(<PathSelector onChoose={vi.fn()} />);
    const grid = container.querySelector(".grid");
    expect(grid).toBeTruthy();
    expect(grid.className).toMatch(/grid-cols-1|(^|\s)grid(\s|$)/);
    expect(grid.className).toMatch(/(^|\s)lg:grid-cols-3(\s|$)/);
    expect(grid.className).not.toMatch(/sm:grid-cols-3/);
  });
});
