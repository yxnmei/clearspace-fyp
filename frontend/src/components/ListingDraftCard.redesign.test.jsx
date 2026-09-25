import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import ListingDraftCard from "./ListingDraftCard";

// The Marketplace Listings redesign: layout, header, seller details,
// staleness, copy payload, no price, and the item-photo lightbox. The
// long-standing behaviour (clipboard races, warning hardening, discard /
// restore, accessibility) stays covered in ListingDraftCard.test.jsx.

function makeGeneratedDraft(overrides = {}) {
  const title = overrides.title ?? "Vintage oak dining table";
  const description = overrides.description ?? "Solid oak dining table, comfortably seats six people.";
  return {
    item_id: "item_001",
    effective_label: "dining table",
    status: "generated",
    unavailable_reason: null,
    was_repaired: false,
    attempts: 1,
    ...overrides,
    title,
    description,
    edited_title: overrides.edited_title ?? title,
    edited_description: overrides.edited_description ?? description,
    is_edited: overrides.is_edited ?? false,
    is_discarded: overrides.is_discarded ?? false,
  };
}

function makeUnavailableDraft(overrides = {}) {
  return {
    item_id: "item_002",
    effective_label: "table lamp",
    status: "unavailable",
    title: null,
    description: null,
    was_repaired: null,
    attempts: 2,
    unavailable_reason: "timeout",
    edited_title: "",
    edited_description: "",
    is_edited: false,
    is_discarded: false,
    ...overrides,
  };
}

function makeReviewItem(overrides = {}) {
  return {
    item_id: "item_001",
    clean_label: "dining table",
    effective_label: "dining table",
    box: { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 },
    ...overrides,
  };
}

describe("ListingDraftCard, marketplace redesign", () => {
  test("two columns from md with a large item image first; below md it stacks image, editor, actions", () => {
    render(<ListingDraftCard draft={makeGeneratedDraft()} reviewItem={makeReviewItem()} imageUrl="blob:room-1" />);
    const grid = screen.getByRole("article").firstElementChild;
    expect(grid.className).toMatch(/\bgrid\b/);
    expect(grid.className).toMatch(/md:grid-cols-\[auto_minmax\(0,1fr\)\]/);
    const [imageColumn, editorColumn] = grid.children;
    expect(imageColumn).toBe(screen.getByRole("button", { name: "Show dining table in the photo" }));
    const crop = within(imageColumn).getByTestId("item-crop-thumbnail");
    expect(crop.className).toMatch(/h-40/);
    expect(crop.className).toMatch(/md:h-56/);
    const title = within(editorColumn).getByLabelText(/listing title for dining table/i);
    const copy = within(editorColumn).getByRole("button", { name: "Copy listing" });
    expect(title.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("the header names the listing with a Draft badge and no numbered badge; a custom name notes the detected label", () => {
    const { rerender, container } = render(
      <ListingDraftCard draft={makeGeneratedDraft()} reviewItem={makeReviewItem()} imageUrl="blob:room-1" />
    );
    expect(screen.getByRole("heading", { level: 3, name: "dining table" })).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(container.querySelector(".rounded-full.bg-primary")).toBeNull();
    expect(screen.queryByText(/detected as/i)).not.toBeInTheDocument();

    rerender(
      <ListingDraftCard
        draft={makeGeneratedDraft({ listing_name: "Oak dining table", condition: "good" })}
        reviewItem={makeReviewItem()}
        imageUrl="blob:room-1"
      />
    );
    expect(screen.getByRole("heading", { level: 3, name: "Oak dining table" })).toBeInTheDocument();
    expect(screen.getByText("Detected as dining table")).toBeInTheDocument();
  });

  test("listing name and condition forward changes for this item_id only and never touch the draft text", async () => {
    const user = userEvent.setup();
    const onDetailsChange = vi.fn();
    const onEdit = vi.fn();
    render(
      <ListingDraftCard
        draft={makeGeneratedDraft({ listing_name: "dining table", condition: "not_specified" })}
        reviewItem={makeReviewItem()}
        imageUrl="blob:room-1"
        onDetailsChange={onDetailsChange}
        onEdit={onEdit}
      />
    );
    const condition = screen.getByLabelText("Condition for dining table");
    expect(condition).toHaveValue("not_specified");
    expect(within(condition).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Not specified",
      "New",
      "Like new",
      "Good",
      "Fair",
      "Well used",
    ]);
    await user.selectOptions(condition, "like_new");
    expect(onDetailsChange).toHaveBeenLastCalledWith("item_001", { condition: "like_new" });

    await user.type(screen.getByLabelText("Listing name for dining table"), "!");
    expect(onDetailsChange).toHaveBeenLastCalledWith("item_001", { listing_name: "dining table!" });
    expect(onEdit).not.toHaveBeenCalled();
  });

  test("a stale draft says so, keeps its text, and describes AI Regenerate", () => {
    render(
      <ListingDraftCard
        draft={makeGeneratedDraft({ is_stale: true, condition: "fair" })}
        reviewItem={makeReviewItem()}
        imageUrl="blob:room-1"
      />
    );
    const notice = screen.getByText(/generated with different listing details/i);
    expect(notice).toHaveTextContent(/use ai regenerate to update it; your text is unchanged/i);
    expect(screen.getByLabelText(/listing title for dining table/i)).toHaveValue("Vintage oak dining table");
    expect(screen.getByRole("button", { name: /ai regenerate/i })).toHaveAccessibleDescription(
      /generated with different listing details/i
    );
  });

  test("a fresh draft shows no stale notice", () => {
    render(
      <ListingDraftCard draft={makeGeneratedDraft({ is_stale: false })} reviewItem={makeReviewItem()} imageUrl="blob:room-1" />
    );
    expect(screen.queryByText(/generated with different listing details/i)).not.toBeInTheDocument();
  });

  test("an edited, stale draft still warns before regeneration replaces the edits", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    render(
      <ListingDraftCard
        draft={makeGeneratedDraft({ is_edited: true, is_stale: true })}
        reviewItem={makeReviewItem()}
        imageUrl="blob:room-1"
        onRegenerate={onRegenerate}
      />
    );
    await user.click(screen.getByRole("button", { name: /^ai regenerate$/i }));
    expect(onRegenerate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /replace my edits and regenerate/i }));
    expect(onRegenerate).toHaveBeenCalledWith("item_001");
  });

  test("Copy writes only the final edited title and description, never the condition or listing name", async () => {
    const user = userEvent.setup();
    const writer = vi.fn().mockResolvedValue(undefined);
    render(
      <ListingDraftCard
        draft={makeGeneratedDraft({
          listing_name: "Oak dining table",
          condition: "good",
          edited_title: "Oak table",
          edited_description: "A solid oak table, seats six.",
          is_edited: true,
        })}
        reviewItem={makeReviewItem()}
        imageUrl="blob:room-1"
        clipboardWriter={writer}
      />
    );
    await user.click(screen.getByRole("button", { name: "Copy listing" }));
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith("Oak table\n\nA solid oak table, seats six.");
  });

  test("no price anywhere: no currency text, price input or slider", () => {
    const { container } = render(
      <ListingDraftCard draft={makeGeneratedDraft({ condition: "good" })} reviewItem={makeReviewItem()} imageUrl="blob:room-1" />
    );
    expect(container.textContent).not.toMatch(/price|SGD|\bRM\b/i);
    expect(container.textContent).not.toMatch(/[$£€]/);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  test("clicking the item image opens the photo with only this item's box highlighted; closing returns focus", async () => {
    const user = userEvent.setup();
    render(
      <ListingDraftCard
        draft={makeGeneratedDraft({ listing_name: "Oak dining table" })}
        reviewItem={makeReviewItem()}
        imageUrl="blob:room-1"
      />
    );
    const trigger = screen.getByRole("button", { name: "Show Oak dining table in the photo" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Oak dining table in your photo" });
    expect(within(dialog).getByRole("img", { name: "The space photo you uploaded" })).toHaveAttribute("src", "blob:room-1");
    const outlines = within(dialog).getAllByTestId("lightbox-overlay");
    expect(outlines).toHaveLength(1);
    expect(outlines[0].style.left).toBe("10%");
    expect(outlines[0].style.width).toBe("40%");
    expect(outlines[0].className).toMatch(/ring-2/);
    expect(within(dialog).getByRole("checkbox", { name: "Show boxes" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("the image is inert when there is no box", () => {
    render(<ListingDraftCard draft={makeGeneratedDraft()} reviewItem={makeReviewItem({ box: null })} imageUrl="blob:room-1" />);
    expect(screen.getByRole("button", { name: "Show dining table in the photo" })).toBeDisabled();
  });

  test("an unavailable draft keeps the image, the details fields and AI Regenerate as recovery, with no Copy", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    const onDetailsChange = vi.fn();
    render(
      <ListingDraftCard
        draft={makeUnavailableDraft()}
        reviewItem={makeReviewItem({ item_id: "item_002", effective_label: "table lamp" })}
        imageUrl="blob:room-1"
        onRegenerate={onRegenerate}
        onDetailsChange={onDetailsChange}
      />
    );
    expect(screen.getByRole("heading", { level: 3, name: "table lamp" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Condition for table lamp"), "good");
    expect(onDetailsChange).toHaveBeenCalledWith("item_002", { condition: "good" });
    await user.click(screen.getByRole("button", { name: /ai regenerate/i }));
    expect(onRegenerate).toHaveBeenCalledWith("item_002");
    expect(screen.queryByRole("button", { name: "Copy listing" })).not.toBeInTheDocument();
  });

  test("rendered copy contains no em dash", () => {
    const { container } = render(
      <ListingDraftCard draft={makeGeneratedDraft({ is_stale: true })} reviewItem={makeReviewItem()} imageUrl="blob:room-1" />
    );
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
